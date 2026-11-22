#!/usr/bin/env node
// `npm run setup`: an interactive wizard for deploying WGO. It asks for the AWS account, region, domain,
// who may sign in and which features to turn on, checks each answer against AWS as it goes, writes
// deploy.env and can start ./scripts/deploy.sh.
//
// Re-running it is safe: the answers in deploy.env (or, without one, the settings of an existing stack) are
// the defaults, and settings it does not ask about (e.g. CLUSTER_METRICS_PROJECT_ID, PARAMS) are kept.
//
// The settings file is $DEPLOY_ENV if set (as in deploy.sh), else ./deploy.env.

import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { c, confirm, intro, log, outro, section, select, setCancelMessage, spin, text } from './setup-ui.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = process.env.DEPLOY_ENV || join(ROOT, 'deploy.env');
const ENV_NAME = relative(process.cwd(), ENV_FILE) || ENV_FILE;

const DEFAULT_RETENTION = '400';
const DEFAULT_WRITE_BUFFER = '30';

// Regions offered first. Aurora DSQL availability is checked against AWS after choosing, so this list is only
// a convenience; "Another region…" accepts any.
const REGIONS = {
  'us-east-1': 'US East (N. Virginia)',
  'us-east-2': 'US East (Ohio)',
  'us-west-2': 'US West (Oregon)',
  'eu-west-1': 'Europe (Ireland)',
  'eu-west-2': 'Europe (London)',
  'eu-west-3': 'Europe (Paris)',
  'eu-central-1': 'Europe (Frankfurt)',
  'ap-northeast-1': 'Asia Pacific (Tokyo)',
  'ap-northeast-2': 'Asia Pacific (Seoul)',
  'ap-northeast-3': 'Asia Pacific (Osaka)',
  'ap-southeast-2': 'Asia Pacific (Sydney)',
};

// Keys this wizard owns in deploy.env. Anything else in the file is carried over untouched.
const MANAGED = [
  'STACK_NAME', 'AWS_REGION', 'AWS_PROFILE', 'CUSTOM_DOMAIN', 'HOSTED_ZONE_ID', 'CERTIFICATE_ARN',
  'ALLOWED_EMAIL_DOMAINS', 'ALLOW_SELF_SIGNUP', 'ADMIN_EMAILS', 'MCP_ENABLED', 'DELETION_PROTECTION', 'MAX_RETENTION_DAYS',
  'WRITE_BUFFER_SECONDS', 'SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET',
];

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('npm run setup is interactive and needs a terminal. To deploy without it, copy');
  console.error('deploy.env.example to deploy.env, edit it, and run ./scripts/deploy.sh.');
  process.exit(1);
}

// ── small helpers ─────────────────────────────────────────────────────────────────────────────────────

const sh = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60_000, maxBuffer: 50e6, ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout ?? '').trim(), stderr: String(stderr ?? '').trim(), missing: err?.code === 'ENOENT' }),
    );
  });

/** Runs the AWS CLI with the chosen profile. Resolves to { ok, data } or { ok: false, error }. */
async function aws(args, { region } = {}) {
  const env = { ...process.env, AWS_PAGER: '' };
  if (cfg.profile) env.AWS_PROFILE = cfg.profile;
  const r = await sh('aws', [...args, ...(region ? ['--region', region] : []), '--output', 'json'], { env });
  if (!r.ok) return { ok: false, error: awsError(r.stderr) };
  try {
    return { ok: true, data: r.stdout ? JSON.parse(r.stdout) : {} };
  } catch {
    return { ok: true, data: r.stdout };
  }
}
const awsError = (stderr) =>
  stderr.split('\n').map((l) => l.trim()).filter(Boolean).find((l) => /error|unable|could not|expired|invalid/i.test(l)) ??
  stderr.split('\n').filter(Boolean).pop() ??
  'unknown error';

/** deploy.env → { KEY: value }. Understands what deploy.sh's `. deploy.env` would: quotes, comments, export. */
function parseEnv(src) {
  const out = {};
  for (const raw of src.split(/\r?\n/)) {
    const m = raw.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith("'")) v = v.replace(/^'|'$/g, '').replaceAll(`'\\''`, "'");
    else if (v.startsWith('"')) v = v.replace(/^"|"$/g, '').replace(/\\(["\\$`])/g, '$1');
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}
const quote = (v) => (/^[\w.,:/@+-]*$/.test(v) ? v : `'${v.replaceAll("'", `'\\''`)}'`);

// Same rules as backend/src/lib/allowlist.ts: `example.com` is exact, `*.example.com` is any subdomain.
const parseAllowlist = (raw = '') =>
  raw.split(/[,\s]+/).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
const emailAllowed = (email, list) => {
  const domain = email.trim().toLowerCase().split('@').pop() ?? '';
  return list.some((d) => (d.startsWith('*.') ? domain.endsWith(d.slice(1)) : domain === d));
};
const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const patternError = (p) => (HOST.test(p.replace(/^\*\./, '')) ? '' : `"${p}" isn't a domain. Use example.com or *.example.com`);
const describePattern = (p) => (p.startsWith('*.') ? `@…${p.slice(1)}` : `@${p}`);

/** "https://WGO.example.com/" → "wgo.example.com". */
const normalizeDomain = (v) => v.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/\.$/, '');
/** wgo.example.com → example.com: a sensible first guess for the email domain. */
const parentDomain = (d) => (d.split('.').length > 2 ? d.split('.').slice(1).join('.') : d);

function readAwsConfig() {
  const file = process.env.AWS_CONFIG_FILE || join(homedir(), '.aws', 'config');
  const profiles = {};
  let cur = null;
  if (!existsSync(file)) return profiles;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = raw.trim();
    if (!t || t.startsWith('#') || t.startsWith(';')) continue;
    const sec = t.match(/^\[([^\]]+)\]$/);
    if (sec) {
      const name = sec[1].trim();
      cur = name === 'default' ? (profiles.default ??= {}) : name.startsWith('profile ') ? (profiles[name.slice(8).trim()] ??= {}) : null;
      continue;
    }
    const kv = t.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (kv && cur) cur[kv[1]] = kv[2];
  }
  return profiles;
}

// ── state ─────────────────────────────────────────────────────────────────────────────────────────────

const hadEnvFile = existsSync(ENV_FILE);
const prev = hadEnvFile ? parseEnv(readFileSync(ENV_FILE, 'utf8')) : {};
const flag = (v, fallback) => (v === undefined || v === '' ? fallback : v === 'true');

const cfg = {
  profile: prev.AWS_PROFILE || process.env.AWS_PROFILE || '',
  account: '',
  region: prev.AWS_REGION || '',
  stackName: prev.STACK_NAME || 'wgo',
  stackStatus: '', // '' = new stack
  domain: prev.CUSTOM_DOMAIN || '',
  hostedZoneId: prev.HOSTED_ZONE_ID || '',
  zoneName: '',
  certificateArn: prev.CERTIFICATE_ARN || '',
  allowlist: parseAllowlist(prev.ALLOWED_EMAIL_DOMAINS),
  selfSignup: flag(prev.ALLOW_SELF_SIGNUP, true),
  admins: parseAllowlist(prev.ADMIN_EMAILS),
  mcp: flag(prev.MCP_ENABLED, true),
  deletionProtection: flag(prev.DELETION_PROTECTION, false),
  maxRetentionDays: prev.MAX_RETENTION_DAYS || '',
  writeBufferSeconds: prev.WRITE_BUFFER_SECONDS || '',
  slackClientId: prev.SLACK_CLIENT_ID || '',
  slackClientSecret: prev.SLACK_CLIENT_SECRET || '',
  extras: Object.fromEntries(Object.entries(prev).filter(([k]) => !MANAGED.includes(k))),
};
const tools = { sam: '', bash: true };

// ── steps ─────────────────────────────────────────────────────────────────────────────────────────────

async function preflight() {
  const node = process.versions.node;
  const r = await spin('Checking the tools the deploy needs', async () => {
    const [awsV, samV, bashV] = await Promise.all([sh('aws', ['--version']), sh('sam', ['--version']), sh('bash', ['--version'])]);
    tools.sam = samV.ok;
    tools.bash = bashV.ok;
    const found = [`Node ${node}`];
    if (awsV.ok) found.push(`AWS CLI ${(awsV.stdout || awsV.stderr).match(/aws-cli\/(\S+)/)?.[1] ?? ''}`.trim());
    if (samV.ok) found.push(`SAM CLI ${samV.stdout.match(/version (\S+)/)?.[1] ?? ''}`.trim());
    return awsV.ok ? { ok: `Found ${found.join(' · ')}` } : { fail: 'The AWS CLI v2 is not installed', awsMissing: true };
  });

  if (Number(node.split('.')[0]) < 22) log.warn(`Node ${node} is too old to build WGO. Install Node 22 or newer.`);
  if (!tools.sam)
    log.warn('The AWS SAM CLI is not installed. You can finish the setup, but you need it to deploy.',
      'https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html');
  if (!tools.bash) log.warn('bash was not found. The deploy script needs Linux, macOS or WSL.');
  if (r.awsMissing) {
    log.info('Setup uses the AWS CLI to check your account, domain and region.', [
      'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html',
      'Install it, run `aws configure` (or `aws configure sso`), then run `npm run setup` again.',
    ]);
    outro(c.red('Setup stopped.'));
    process.exit(1);
  }
}

async function stepAws(n, total) {
  section(n, total, 'AWS account', 'WGO runs in your own AWS account: Lambda, Aurora DSQL, S3, CloudFront and Cognito.');

  // profile
  const config = readAwsConfig();
  const listed = await sh('aws', ['configure', 'list-profiles']);
  const profiles = listed.stdout.split('\n').map((p) => p.trim()).filter(Boolean);
  const envCreds = Boolean(process.env.AWS_ACCESS_KEY_ID);
  for (;;) {
    if (profiles.length + (envCreds ? 1 : 0) === 0) {
      log.error('No AWS credentials are configured.', 'Run `aws configure` (or `aws configure sso`), then run `npm run setup` again.');
      outro(c.red('Setup stopped.'));
      process.exit(1);
    }
    if (profiles.length + (envCreds ? 1 : 0) === 1) {
      cfg.profile = profiles[0] ?? '';
      log.info(cfg.profile ? `Using AWS profile ${c.cyan(cfg.profile)}` : 'Using the AWS credentials from your environment');
    } else {
      const options = profiles.map((p) => ({
        value: p,
        label: p,
        hint: [config[p]?.region, config[p]?.sso_start_url || config[p]?.sso_session ? 'SSO' : ''].filter(Boolean).join(' · '),
      }));
      if (envCreds) options.unshift({ value: '', label: 'Credentials from my environment', hint: 'AWS_ACCESS_KEY_ID' });
      cfg.profile = await select({
        message: 'Which AWS profile should WGO deploy with?',
        help: 'Use an account where you can create IAM roles. An administrator role is simplest.',
        options,
        initial: cfg.profile || (envCreds ? '' : 'default'),
      });
    }

    const who = await spin('Checking the credentials', async () => {
      const r = await aws(['sts', 'get-caller-identity']);
      if (!r.ok) return { fail: "Couldn't sign in to AWS with these credentials", details: r.error, error: r.error };
      cfg.account = r.data.Account;
      const as = r.data.Arn.split(':').pop().replace(/^assumed-role\//, '').split('/')[0];
      return { ok: `Signed in to account ${c.cyan(cfg.account)} as ${as}` };
    });
    if (!who.fail) break;

    const sso = cfg.profile && (config[cfg.profile]?.sso_start_url || config[cfg.profile]?.sso_session || /sso|token/i.test(who.error));
    const next = await select({
      message: 'What now?',
      options: [
        ...(sso ? [{ value: 'login', label: `Sign in with aws sso login --profile ${cfg.profile}` }] : []),
        { value: 'retry', label: profiles.length > 1 ? 'Try again or pick another profile' : 'Try again' },
        { value: 'quit', label: 'Quit' },
      ],
    });
    if (next === 'quit') cancelOut();
    if (next === 'login') await new Promise((r) => spawn('aws', ['sso', 'login', '--profile', cfg.profile], { stdio: 'inherit' }).on('exit', r));
  }

  // region
  const profileRegion = config[cfg.profile || 'default']?.region || process.env.AWS_REGION || '';
  for (;;) {
    const current = cfg.region || profileRegion || 'eu-west-1';
    const codes = [...new Set([current, ...Object.keys(REGIONS)])];
    const choice = await select({
      message: 'Which region?',
      help: 'Pick one close to your users. It must offer Aurora DSQL; that is checked next.',
      options: [
        ...codes.map((r) => ({
          value: r,
          label: REGIONS[r] ? `${r.padEnd(15)} ${REGIONS[r]}` : r,
          hint: r === profileRegion ? 'your profile default' : '',
        })),
        { value: '', label: 'Another region…' },
      ],
      initial: current,
    });
    cfg.region =
      choice ||
      (await text({
        message: 'Region code',
        placeholder: 'e.g. ap-southeast-1',
        validate: (v) => (/^[a-z]{2}(-[a-z]+)+-\d$/.test(v) ? '' : 'That is not a region code like eu-west-1'),
      }));

    const dsql = await spin(`Checking Aurora DSQL in ${cfg.region}`, async () => {
      const r = await aws(['dsql', 'list-clusters', '--max-results', '1'], { region: cfg.region });
      if (r.ok) return { ok: `Aurora DSQL is available in ${cfg.region}` };
      if (/could not connect to the endpoint/i.test(r.error)) return { fail: `Aurora DSQL is not available in ${cfg.region}`, bad: true };
      return { warn: `Couldn't confirm Aurora DSQL in ${cfg.region}; continuing`, details: r.error };
    });
    if (!dsql.bad) break;
    cfg.region = '';
  }

  // stack
  cfg.stackName = await text({
    message: 'Stack name',
    help: 'The CloudFormation stack that holds WGO. Keep the default unless you run more than one WGO in this account and region.',
    initial: cfg.stackName,
    validate: (v) => (/^[A-Za-z][A-Za-z0-9-]{0,99}$/.test(v) ? '' : 'Letters, digits and hyphens, starting with a letter'),
  });
  const stack = await spin(`Looking for an existing stack named ${cfg.stackName}`, async () => {
    const r = await aws(['cloudformation', 'describe-stacks', '--stack-name', cfg.stackName], { region: cfg.region });
    if (!r.ok) {
      cfg.stackStatus = '';
      return /does not exist/i.test(r.error) ? { ok: `No stack named ${cfg.stackName} yet: this is a fresh install` } : { warn: "Couldn't look up the stack", details: r.error };
    }
    const s = r.data.Stacks[0];
    cfg.stackStatus = s.StackStatus;
    if (s.StackStatus === 'ROLLBACK_COMPLETE')
      return {
        warn: `Stack ${cfg.stackName} is left over from a failed first deploy (ROLLBACK_COMPLETE) and can't be updated`,
        details: `Delete it before deploying: aws cloudformation delete-stack --stack-name ${cfg.stackName} --region ${cfg.region}`,
      };
    return { ok: `Stack ${cfg.stackName} exists (${s.StackStatus}): deploying updates it`, params: s.Parameters ?? [] };
  });
  if (stack.params && !hadEnvFile) adoptStackParameters(stack.params);
}

/** Without a deploy.env, an existing stack's parameters are the best defaults: redeploying keeps them. */
function adoptStackParameters(params) {
  const p = Object.fromEntries(params.map((x) => [x.ParameterKey, x.ParameterValue ?? '']));
  cfg.domain = p.CustomDomain || cfg.domain;
  cfg.hostedZoneId = p.HostedZoneId || cfg.hostedZoneId;
  cfg.certificateArn = p.CertificateArn || cfg.certificateArn;
  if (p.AllowedEmailDomains !== undefined) cfg.allowlist = parseAllowlist(p.AllowedEmailDomains);
  if (p.AllowSelfSignup) cfg.selfSignup = p.AllowSelfSignup === 'true';
  if (p.AdminEmails !== undefined) cfg.admins = parseAllowlist(p.AdminEmails);
  if (p.EnableMcp) cfg.mcp = p.EnableMcp === 'true';
  if (p.DeletionProtection) cfg.deletionProtection = p.DeletionProtection === 'true';
  if (p.MaxRetentionDays && p.MaxRetentionDays !== DEFAULT_RETENTION) cfg.maxRetentionDays = p.MaxRetentionDays;
  if (p.WriteBufferSeconds && p.WriteBufferSeconds !== DEFAULT_WRITE_BUFFER) cfg.writeBufferSeconds = p.WriteBufferSeconds;
  if (p.SlackClientId) cfg.slackClientId = p.SlackClientId; // the secret is NoEcho: asked for in stepAdvanced
  log.info('Loaded the current settings of that stack as defaults.');
}

async function stepDomain(n, total) {
  section(n, total, 'Web address', 'Where the dashboard, the browser SDK and the ingest endpoint are served.');
  const own = await select({
    message: 'Where should WGO live?',
    options: [
      { value: true, label: 'On my own domain', hint: 'e.g. wgo.example.com' },
      { value: false, label: 'On a free *.cloudfront.net address', hint: 'nothing to set up; you can add a domain later by running setup again' },
    ],
    initial: Boolean(cfg.domain),
  });
  if (!own) return clearDomain();

  for (;;) {
    cfg.domain = await text({
      message: 'Domain name',
      help: 'A domain or subdomain you control. A subdomain like wgo.example.com keeps it apart from your website.',
      initial: cfg.domain,
      placeholder: 'wgo.example.com',
      validate: (v) => (HOST.test(normalizeDomain(v)) ? '' : 'Enter a domain name like wgo.example.com'),
      display: normalizeDomain,
    });
    cfg.domain = normalizeDomain(cfg.domain);

    const zone = await spin(`Looking for ${cfg.domain} in Route 53`, async () => {
      const r = await aws(['route53', 'list-hosted-zones']);
      if (!r.ok) return { warn: "Couldn't list your Route 53 zones", details: r.error };
      const fqdn = `${cfg.domain}.`;
      const match = r.data.HostedZones.filter((z) => !z.Config?.PrivateZone && (fqdn === z.Name || fqdn.endsWith(`.${z.Name}`)))
        .sort((a, b) => b.Name.length - a.Name.length)[0];
      if (!match) return { warn: `${cfg.domain} is not in a Route 53 zone in this account` };
      return {
        ok: `Found Route 53 zone ${match.Name.replace(/\.$/, '')}: the certificate and DNS records are set up automatically`,
        zone: match,
      };
    });
    if (zone.zone) {
      cfg.hostedZoneId = zone.zone.Id.split('/').pop();
      cfg.zoneName = zone.zone.Name.replace(/\.$/, '');
      cfg.certificateArn = '';
      return;
    }

    // DNS elsewhere: CloudFront needs an ACM certificate in us-east-1, and a CNAME after the deploy.
    cfg.hostedZoneId = '';
    cfg.zoneName = '';
    const done = await chooseCertificate();
    if (done === 'domain') continue;
    if (done === 'skip') return clearDomain();
    return;
  }
}

function clearDomain() {
  cfg.domain = cfg.hostedZoneId = cfg.zoneName = cfg.certificateArn = '';
}

async function chooseCertificate() {
  for (;;) {
    const certs = await spin('Looking for a matching certificate in ACM (us-east-1)', async () => {
      const r = await aws(
        ['acm', 'list-certificates', '--certificate-statuses', 'ISSUED', '--includes',
          'keyTypes=RSA_1024,RSA_2048,RSA_3072,RSA_4096,EC_prime256v1,EC_secp384r1,EC_secp521r1'],
        { region: 'us-east-1' },
      );
      if (!r.ok) return { warn: "Couldn't list your certificates", details: r.error, list: [] };
      const covers = (name) => name === cfg.domain || (name.startsWith('*.') && cfg.domain.split('.').slice(1).join('.') === name.slice(2));
      const list = r.data.CertificateSummaryList.filter((s) => [s.DomainName, ...(s.SubjectAlternativeNameSummaries ?? [])].some(covers));
      return list.length
        ? { ok: `Found ${list.length === 1 ? 'a certificate' : `${list.length} certificates`} for ${cfg.domain}`, list }
        : { warn: `No issued certificate for ${cfg.domain} in us-east-1 yet`, list };
    });

    const choice = await select({
      message: 'How should CloudFront get its HTTPS certificate?',
      help: [
        `Your DNS is hosted outside this AWS account, so WGO can't create the certificate or the DNS record for you.`,
        certs.list.length
          ? ''
          : `To create a certificate, request one in ACM in us-east-1 and add the validation record it shows to your DNS: aws acm request-certificate --region us-east-1 --validation-method DNS --domain-name ${cfg.domain}`,
        'After the deploy, point a CNAME for the domain at the CloudFront address that the deploy prints.',
      ].filter(Boolean),
      options: [
        ...certs.list.map((s) => ({ value: s.CertificateArn, label: `Use the certificate for ${s.DomainName}`, hint: `…${s.CertificateArn.slice(-12)}` })),
        { value: 'paste', label: 'Paste a certificate ARN' },
        ...(certs.list.length ? [] : [{ value: 'again', label: "I've requested one: look again" }]),
        { value: 'domain', label: 'Use a different domain' },
        { value: 'skip', label: 'Skip the domain for now', hint: 'use the *.cloudfront.net address' },
      ],
      initial: cfg.certificateArn && certs.list.some((s) => s.CertificateArn === cfg.certificateArn) ? cfg.certificateArn : undefined,
    });
    if (choice === 'again') continue;
    if (choice === 'domain' || choice === 'skip') return choice;
    cfg.certificateArn =
      choice !== 'paste'
        ? choice
        : await text({
            message: 'Certificate ARN',
            help: 'It must be in us-east-1 (a CloudFront requirement) and cover the domain.',
            initial: cfg.certificateArn,
            placeholder: 'arn:aws:acm:us-east-1:123456789012:certificate/…',
            validate: (v) =>
              /^arn:aws[\w-]*:acm:us-east-1:\d{12}:certificate\/[\w-]+$/.test(v) ? '' : 'Needs an ACM certificate ARN in us-east-1',
          });
    log.info(`After the deploy, add a CNAME record for ${c.cyan(cfg.domain)} that points at the CloudFront address it prints.`);
    return 'ok';
  }
}

async function stepAccess(n, total) {
  section(n, total, 'Who can sign in', 'People sign up with their email address and confirm it with a code.');
  const restricted = await select({
    message: 'Who should be able to use the dashboard?',
    options: [
      { value: true, label: 'Only people with my email domain(s)', hint: 'recommended for a team or company' },
      { value: false, label: 'Anyone with a verified email address', hint: 'they only see projects they create or are invited to' },
    ],
    initial: cfg.allowlist.length > 0 || !hadEnvFile,
  });

  if (!restricted) cfg.allowlist = [];
  else {
    const raw = await text({
      message: 'Allowed email domains',
      help: 'Separate them with commas. example.com allows @example.com; *.example.com allows any subdomain, like @eu.example.com.',
      initial: cfg.allowlist.join(', ') || (cfg.domain ? parentDomain(cfg.domain) : ''),
      placeholder: 'example.com, *.example.org',
      preview: (v) => {
        const list = parseAllowlist(v);
        if (!list.length) return null;
        const bad = list.map(patternError).find(Boolean);
        return bad ? c.yellow(bad) : c.dim(`Lets in ${list.map(describePattern).join(', ')}`);
      },
      validate: (v) => {
        const list = parseAllowlist(v);
        if (!list.length) return 'Enter at least one domain';
        return list.map(patternError).find(Boolean);
      },
      display: (v) => parseAllowlist(v).join(', '),
    });
    cfg.allowlist = [...new Set(parseAllowlist(raw))];

    // `*.example.org` does not match example.org itself, which surprises people
    for (const p of cfg.allowlist.filter((d) => d.startsWith('*.'))) {
      const bare = p.slice(2);
      if (cfg.allowlist.includes(bare)) continue;
      const add = await confirm({
        message: `Also allow @${bare}?`,
        help: `${p} lets in subdomains like @eu.${bare}, but not @${bare} itself.`,
        initial: true,
      });
      if (add) cfg.allowlist.splice(cfg.allowlist.indexOf(p), 0, bare);
    }

    await text({
      message: 'Try an email address (optional)',
      help: 'Type an address to see whether it gets in. Press enter to continue.',
      placeholder: 'alice@example.com',
      preview: (v) => {
        if (!v) return null;
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return c.dim('…');
        return emailAllowed(v, cfg.allowlist) ? c.green('✔ allowed') : c.red('✖ not allowed');
      },
      display: (v) => (v ? `${v}: ${emailAllowed(v, cfg.allowlist) ? 'allowed' : 'not allowed'}` : 'skipped'),
    });
  }

  cfg.selfSignup = await confirm({
    message: 'Can people create their own accounts?',
    help: cfg.allowlist.length
      ? 'Yes: anyone with an allowed address signs up from the dashboard. No: you create every account yourself in Cognito.'
      : 'Yes: anyone signs up from the dashboard. No: you create every account yourself in Cognito.',
    initial: cfg.selfSignup,
  });
  if (!cfg.selfSignup)
    log.info('After the deploy, add people with:', [
      'aws cognito-idp admin-create-user --user-pool-id <UserPoolId stack output> --username alice@example.com',
      'Cognito emails them a temporary password.',
    ]);

  const admins = await text({
    message: 'Admin emails (optional)',
    help: 'Admins see what the install costs and set budgets, which can stop every project collecting data. Separate them with commas. Leave empty to make the owners of the first project the admins.',
    initial: cfg.admins.join(', '),
    placeholder: 'you@example.com',
    validate: (v) => parseAllowlist(v).find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) && 'Enter email addresses, separated by commas',
    display: (v) => parseAllowlist(v).join(', ') || 'the first project’s owners',
  });
  cfg.admins = [...new Set(parseAllowlist(admins))];
}

async function stepFeatures(n, total) {
  section(n, total, 'Features');
  cfg.mcp = await confirm({
    message: 'Let AI assistants query your analytics over MCP?',
    help: `Serves an MCP server at ${cfg.domain ? `https://${cfg.domain}` : 'your WGO address'}/mcp for Claude, Cursor and other MCP clients. They register themselves; people still sign in with their WGO account.`,
    initial: cfg.mcp,
  });
  cfg.deletionProtection = await confirm({
    message: 'Turn on deletion protection for the database?',
    help: "Recommended once you rely on the data: the Aurora DSQL cluster can't be deleted until you turn it off again. Leave it off while you're trying WGO out.",
    initial: cfg.deletionProtection,
  });
  const advanced = await confirm({
    message: 'Change any advanced settings?',
    help: 'Data retention limit, write buffering and an instance-wide Slack app. The defaults suit most installs.',
    initial: Boolean(cfg.maxRetentionDays || cfg.writeBufferSeconds || (cfg.slackClientId && !cfg.slackClientSecret)),
  });
  if (advanced) await stepAdvanced();
  else if (cfg.slackClientId && !cfg.slackClientSecret) await askSlackSecret();
}

// Stack parameters hide the secret, and deploying a client ID with an empty secret would erase it.
async function askSlackSecret() {
  cfg.slackClientSecret = await text({
    message: 'Slack client secret',
    help: cfg.slackClientId ? `The secret of Slack app ${cfg.slackClientId}, from api.slack.com/apps → Basic Information → App Credentials.` : undefined,
    initial: cfg.slackClientSecret,
    mask: true,
    validate: (v) => (v ? '' : 'Required with a client ID'),
    display: (v) => '•'.repeat(Math.min(v.length, 12)),
  });
}

async function stepAdvanced() {
  const number = (min, max) => (v) => (/^\d+$/.test(v) && +v >= min && +v <= max ? '' : `A whole number from ${min} to ${max}`);
  const days = await text({
    message: 'Longest data retention project owners can choose (days)',
    help: 'Each project keeps raw data for 90 days unless its owner changes it, up to this limit. More days means more storage cost.',
    initial: cfg.maxRetentionDays || DEFAULT_RETENTION,
    validate: number(1, 3650),
  });
  cfg.maxRetentionDays = days === DEFAULT_RETENTION ? '' : days;

  const secs = await text({
    message: 'Write buffer (seconds)',
    help: 'How long incoming data is collected before it is written as one file. Shorter means fresher charts; longer means fewer files and cheaper queries. The Live page and triggers are not delayed by it.',
    initial: cfg.writeBufferSeconds || DEFAULT_WRITE_BUFFER,
    validate: number(1, 300),
  });
  cfg.writeBufferSeconds = secs === DEFAULT_WRITE_BUFFER ? '' : secs;

  const slack = await select({
    message: 'Slack notifications for triggers',
    options: [
      { value: false, label: 'Each project connects Slack itself', hint: 'from its Triggers page, about a minute; no redeploy' },
      { value: true, label: 'One Slack app for every project', hint: 'needs the client id and secret of a Slack app' },
    ],
    initial: Boolean(cfg.slackClientId),
  });
  if (!slack) {
    cfg.slackClientId = cfg.slackClientSecret = '';
    return;
  }
  cfg.slackClientId = await text({
    message: 'Slack client ID',
    help: 'From your Slack app at api.slack.com/apps, under Basic Information → App Credentials.',
    initial: cfg.slackClientId,
    validate: (v) => (/^\d+\.\d+$/.test(v) ? '' : 'A Slack client ID looks like 1234567890.1234567890'),
  });
  await askSlackSecret();
}

// ── review, save, deploy ──────────────────────────────────────────────────────────────────────────────

function summary() {
  const row = (k, v) => `${c.dim(k.padEnd(11))}${v}`;
  const yes = (b, on, off) => (b ? c.green(on) : off);
  let address = c.dim('the *.cloudfront.net address');
  if (cfg.domain)
    address = `https://${cfg.domain}  ${c.dim(cfg.hostedZoneId ? `certificate + DNS automatic (Route 53 zone ${cfg.zoneName || cfg.hostedZoneId})` : 'your certificate; add a CNAME after deploying')}`;
  const advanced = [
    `retention up to ${cfg.maxRetentionDays || DEFAULT_RETENTION} days`,
    `${cfg.writeBufferSeconds || DEFAULT_WRITE_BUFFER} s write buffer`,
    cfg.slackClientId ? 'one Slack app' : 'Slack per project',
  ];
  return [
    row('AWS', `account ${cfg.account}${cfg.profile ? ` · profile ${cfg.profile}` : ''} · ${cfg.region}`),
    row('Stack', `${cfg.stackName}  ${c.dim(cfg.stackStatus ? `exists, will be updated` : 'new')}`),
    row('Address', address),
    row('Sign-in', `${cfg.allowlist.length ? `only ${cfg.allowlist.map(describePattern).join(', ')}` : 'anyone with a verified email'} · ${cfg.selfSignup ? 'self sign-up' : 'accounts created by you'}`),
    row('Admins', cfg.admins.length ? cfg.admins.join(', ') : c.dim('the first project’s owners')),
    row('MCP', yes(cfg.mcp, 'on', 'off')),
    row('Database', cfg.deletionProtection ? c.green('deletion protection on') : 'deletion protection off'),
    row('Advanced', c.dim(advanced.join(' · '))),
    ...(Object.keys(cfg.extras).length ? [row('Kept', c.dim(Object.keys(cfg.extras).join(', ')))] : []),
  ];
}

function toEnvFile() {
  const out = [
    `# WGO deploy settings, written by \`npm run setup\` on ${new Date().toISOString().slice(0, 10)}.`,
    '# Run it again to change them, or edit this file: deploy.env.example lists every option. Gitignored.',
  ];
  const group = (title, pairs) => {
    const set = pairs.filter(([, v]) => v !== '' && v !== undefined && v !== null);
    if (set.length) out.push('', ...(title ? [`# ${title}`] : []), ...set.map(([k, v]) => `${k}=${quote(String(v))}`));
  };
  group('', [['STACK_NAME', cfg.stackName], ['AWS_REGION', cfg.region], ['AWS_PROFILE', cfg.profile]]);
  group('Web address', [['CUSTOM_DOMAIN', cfg.domain], ['HOSTED_ZONE_ID', cfg.hostedZoneId], ['CERTIFICATE_ARN', cfg.certificateArn]]);
  group('Who can sign in', [['ALLOWED_EMAIL_DOMAINS', cfg.allowlist.join(',')], ['ALLOW_SELF_SIGNUP', String(cfg.selfSignup)], ['ADMIN_EMAILS', cfg.admins.join(',')]]);
  group('Features', [
    ['MCP_ENABLED', String(cfg.mcp)],
    ['DELETION_PROTECTION', String(cfg.deletionProtection)],
    ['MAX_RETENTION_DAYS', cfg.maxRetentionDays],
    ['WRITE_BUFFER_SECONDS', cfg.writeBufferSeconds],
    ['SLACK_CLIENT_ID', cfg.slackClientId],
    ['SLACK_CLIENT_SECRET', cfg.slackClientSecret],
  ]);
  group('Kept from the previous file', Object.entries(cfg.extras));
  return `${out.join('\n')}\n`;
}

function save() {
  writeFileSync(ENV_FILE, toEnvFile(), { mode: 0o600 });
  log.ok(`Saved your settings to ${c.cyan(ENV_NAME)}`);
}

function cancelOut() {
  outro(c.red('Setup cancelled. Nothing was saved.'));
  process.exit(130);
}

const STEPS = [
  { key: 'aws', label: 'AWS account, region and stack', run: stepAws },
  { key: 'domain', label: 'Web address', run: stepDomain },
  { key: 'access', label: 'Who can sign in', run: stepAccess },
  { key: 'features', label: 'Features and advanced settings', run: stepFeatures },
];

async function main() {
  intro('WGO setup', 'configures your deploy in a few questions · Ctrl+C to quit');
  setCancelMessage('Setup cancelled. Nothing was saved.');
  if (hadEnvFile) log.info(`Found ${c.cyan(ENV_NAME)}: your current settings are the defaults.`);
  await preflight();

  for (const [i, s] of STEPS.entries()) await s.run(i + 1, STEPS.length);

  for (;;) {
    log.lines(['', c.bold('Review'), '', ...summary()]);
    const blocked = !tools.sam ? 'install the AWS SAM CLI first' : !tools.bash ? 'needs bash' : cfg.stackStatus === 'ROLLBACK_COMPLETE' ? 'delete the failed stack first' : '';
    const action = await select({
      message: 'Ready?',
      options: [
        { value: 'deploy', label: 'Save and deploy now', hint: cfg.stackStatus ? 'about 5 minutes' : 'the first deploy takes 10–20 minutes', disabled: blocked || undefined },
        { value: 'save', label: 'Save, deploy later', hint: 'with npm run deploy' },
        { value: 'change', label: 'Change something…' },
        { value: 'quit', label: 'Quit without saving' },
      ],
      initial: blocked ? 'save' : 'deploy',
    });
    if (action === 'quit') cancelOut();
    if (action === 'change') {
      const which = await select({
        message: 'What do you want to change?',
        options: [...STEPS.map((s) => ({ value: s.key, label: s.label })), { value: 'back', label: 'Nothing, back to the review' }],
      });
      const step = STEPS.find((s) => s.key === which);
      if (step) {
        await step.run(STEPS.indexOf(step) + 1, STEPS.length);
        // a different account or profile can see different Route 53 zones and certificates
        if (step.key === 'aws' && cfg.domain) await stepDomain(2, STEPS.length);
      }
      continue;
    }

    save();
    if (action === 'save') {
      outro(`Done. Deploy whenever you're ready with ${c.cyan('npm run deploy')}`);
      return;
    }
    outro(`Deploying ${c.bold(cfg.stackName)} to ${cfg.region}. When it finishes, create your account at the Sign up address it prints.`);
    const child = spawn('bash', [join(ROOT, 'scripts', 'deploy.sh')], { stdio: 'inherit', env: { ...process.env, DEPLOY_ENV: ENV_FILE } });
    child.on('exit', (code, signal) => {
      if (code !== 0)
        console.error(`\n${c.red('✖')} The deploy failed. Your settings are saved in ${ENV_NAME}: fix the error above and run ${c.cyan('npm run deploy')}.\n`);
      process.exit(code ?? (signal ? 1 : 0));
    });
    return;
  }
}

main().catch((err) => {
  console.error(`\n${c.red('✖')} ${err?.stack ?? err}`);
  process.exit(1);
});
