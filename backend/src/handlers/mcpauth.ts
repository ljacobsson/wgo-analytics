import type { CloudFormationCustomResourceEvent, Context } from 'aws-lambda';
import {
  CognitoIdentityProviderClient, DescribeUserPoolCommand, ResourceNotFoundException, UpdateUserPoolCommand,
  type DcrConfigurationType, type UpdateUserPoolRequest, type UserPoolType,
} from '@aws-sdk/client-cognito-identity-provider';
import { getSetting, setSetting, type McpSetting } from '../lib/installSettings';

/**
 * Turns Cognito's MCP auth (dynamic client registration) on or off for the user pool. CloudFormation has no property
 * for it yet. This is the only code with permission to change the pool. Invoked two ways:
 * - as a CloudFormation custom resource on every deploy: applies the admins' choice saved in install_settings ('mcp').
 *   Installs from before the dashboard switch keep what they had (the old EnableMcp parameter, default on); new
 *   installs start with MCP off. It also saves the pool id and allowed scopes for the direct invocation;
 * - directly by the API ({ action: 'set', enabled }) when an admin flips the switch on the MCP page.
 *
 * UpdateUserPool resets every setting it isn't given to its default, so the current configuration is read
 * first and sent back unchanged with only DcrConfiguration replaced. CloudFormation's own UserPool updates
 * may in turn drop DcrConfiguration, so the template re-runs this whenever the pool's configuration changes.
 *
 * Properties: UserPoolId, AllowedScopes (string[]).
 */

const cognito = new CognitoIdentityProviderClient({});

/** UpdateUserPool fields that DescribeUserPool returns under the same name (PoolName is `Name` there). */
const COPIED = [
  'Policies', 'DeletionProtection', 'LambdaConfig', 'AutoVerifiedAttributes', 'SmsVerificationMessage', 'EmailVerificationMessage',
  'EmailVerificationSubject', 'VerificationMessageTemplate', 'SmsAuthenticationMessage', 'UserAttributeUpdateSettings', 'MfaConfiguration',
  'DeviceConfiguration', 'EmailConfiguration', 'SmsConfiguration', 'UserPoolTags', 'AdminCreateUserConfig', 'UserPoolAddOns',
  'AccountRecoverySetting', 'UserPoolTier', 'KeyConfiguration', 'IssuerConfiguration', 'AcrConfiguration',
] as const satisfies ReadonlyArray<keyof UpdateUserPoolRequest & keyof UserPoolType>;

export function updateRequest(pool: UserPoolType, dcr: DcrConfigurationType): UpdateUserPoolRequest {
  const req: UpdateUserPoolRequest = { UserPoolId: pool.Id, PoolName: pool.Name, DcrConfiguration: dcr };
  for (const key of COPIED) if (pool[key] !== undefined) (req as unknown as Record<string, unknown>)[key] = pool[key];
  // Describe reports the deprecated single-version trigger next to its successor; sending both is rejected
  // when they disagree, and PreTokenGenerationConfig carries everything.
  if (req.LambdaConfig?.PreTokenGenerationConfig) req.LambdaConfig = { ...req.LambdaConfig, PreTokenGeneration: undefined };
  return req;
}

export function dcrConfig(enabled: boolean, allowedScopes: string[]): DcrConfigurationType {
  if (!enabled) return { EnableStatus: 'Disabled' };
  return {
    EnableStatus: 'Enabled',
    // MCP clients register on their own, without an initial access token
    OpenDcrEnabled: true,
    OpenDcrGrantTypes: ['code'],
    AuthenticatedGrantTypes: ['code'],
    AllowedScopes: allowedScopes,
  };
}

async function apply(userPoolId: string, dcr: DcrConfigurationType): Promise<void> {
  const { UserPool } = await cognito.send(new DescribeUserPoolCommand({ UserPoolId: userPoolId }));
  if (!UserPool) throw new Error(`User pool ${userPoolId} not found`);
  await cognito.send(new UpdateUserPoolCommand(updateRequest(UserPool, dcr)));
}

/** The switch on the MCP page: apply it to the pool, then remember it. */
async function setFromApi(enabled: boolean): Promise<{ enabled: boolean }> {
  const s = await getSetting<McpSetting>('mcp');
  if (!s?.userPoolId) throw new Error('MCP auth was never deployed: deploy the stack again');
  await apply(s.userPoolId, dcrConfig(enabled, s.scopes ?? []));
  await setSetting('mcp', { ...s, enabled }, 'dashboard');
  return { enabled };
}

/** On a deploy: the saved choice, or (first deploy with the switch) what the install had. */
async function deployedState(event: CloudFormationCustomResourceEvent, props: { UserPoolId: string; AllowedScopes?: string[] }): Promise<boolean> {
  const legacy = event.RequestType === 'Update' ? (event.OldResourceProperties as { Enabled?: string }).Enabled !== 'false' : false;
  try {
    const saved = await getSetting<McpSetting>('mcp');
    const enabled = saved ? saved.enabled === true : legacy;
    await setSetting('mcp', { enabled, userPoolId: props.UserPoolId, scopes: props.AllowedScopes ?? [] }, 'deploy');
    return enabled;
  } catch (err) {
    console.warn('could not read or save the MCP setting, keeping the previous state', err);
    return legacy;
  }
}

export async function handler(event: CloudFormationCustomResourceEvent | { action: 'set'; enabled: boolean }, context: Context): Promise<unknown> {
  if ('action' in event) return setFromApi(event.enabled === true);
  const props = event.ResourceProperties as unknown as { UserPoolId: string; AllowedScopes?: string[] };
  let status: 'SUCCESS' | 'FAILED' = 'SUCCESS';
  let reason = '';
  try {
    if (event.RequestType === 'Delete') {
      // Best effort: the pool may already be gone (stack deletion, or a replaced pool), and a failed Delete
      // would leave the stack stuck.
      await apply(props.UserPoolId, dcrConfig(false, [])).catch((err) => {
        if (!(err instanceof ResourceNotFoundException)) console.warn('could not disable DCR:', err);
      });
    } else {
      const enabled = await deployedState(event, props);
      console.log(`DCR ${enabled ? 'enabled' : 'disabled'} on ${props.UserPoolId}`, props.AllowedScopes);
      await apply(props.UserPoolId, dcrConfig(enabled, props.AllowedScopes ?? []));
    }
  } catch (err) {
    console.error(err);
    status = 'FAILED';
    reason = String((err as Error).message ?? err).slice(0, 500);
  }

  const body = JSON.stringify({
    Status: status,
    Reason: reason || `See CloudWatch log stream ${context.logStreamName}`,
    // one physical resource per pool: a replaced pool makes CloudFormation delete (disable) the old one
    PhysicalResourceId: `${props.UserPoolId}-mcp-auth`,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
  });
  await fetch(event.ResponseURL, { method: 'PUT', body, headers: { 'content-type': '', 'content-length': String(Buffer.byteLength(body)) } });
}
