import { useEffect, type ReactNode } from 'react';
import { CodeBlock } from '../ui/CodeBlock';
import { SiteFooter, SiteHeader } from '../site/Site';

/**
 * Public guide: sending OpenTelemetry from Node.js and Python backends, on servers and on AWS Lambda.
 * Every example here was run against a WGO backend (Lambda ones in the official AWS Lambda runtime images),
 * so keep code changes in step with what the SDKs actually do.
 */

const KEY = 'wk_…';

const SECTIONS = [
  ['connect', 'Connection settings'],
  ['node-server', 'Node.js on a server'],
  ['node-lambda', 'Node.js on AWS Lambda'],
  ['python-server', 'Python on a server'],
  ['python-lambda', 'Python on AWS Lambda'],
  ['check', 'Checking that it works'],
] as const;

const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-line pt-12 first:border-t-0 first:pt-0">
      <h2 className="text-[24px] font-semibold tracking-tight">{title}</h2>
      <div className="mt-5 space-y-5">{children}</div>
    </section>
  );
}
function Step({ title, children }: { title: string; children: ReactNode }) {
  return <div className="space-y-3"><h3 className="text-[15px] font-semibold">{title}</h3>{children}</div>;
}
const P = ({ children }: { children: ReactNode }) => <p className="text-[14.5px] leading-relaxed text-muted">{children}</p>;
const C = ({ children }: { children: ReactNode }) => <code className="rounded bg-[var(--hl)] px-1 py-px font-mono text-[12.5px] text-fg">{children}</code>;
const Code = (p: Parameters<typeof CodeBlock>[0]) => <CodeBlock wrap={false} {...p} />;
const Ext = ({ href, children }: { href: string; children: ReactNode }) => <a href={href} target="_blank" rel="noreferrer" className="text-accent hover:underline">{children}</a>;

export function OtelDocs() {
  const origin = window.location.origin;
  useEffect(() => { document.title = 'OpenTelemetry setup · WGO'; return () => { document.title = 'WGO'; }; }, []);

  const env = `OTEL_SERVICE_NAME=checkout-api
OTEL_EXPORTER_OTLP_ENDPOINT=${origin}
OTEL_EXPORTER_OTLP_HEADERS=x-wgo-key=${KEY}
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`;

  const nodeServerApp = `const http = require('node:http');
const { trace, metrics } = require('@opentelemetry/api');
const logger = require('pino')();

const tracer = trace.getTracer('shop');
const orders = metrics.getMeter('shop').createCounter('orders.placed');

http.createServer(async (req, res) => {
  await tracer.startActiveSpan('place-order', async (span) => {
    span.setAttribute('order.items', 3);
    orders.add(1, { plan: 'pro' });
    logger.info({ items: 3 }, 'order placed'); // pino logs are sent to WGO too
    span.end();
  });
  res.end('ok');
}).listen(3000);`;

  const nodeLambdaOtel = `// Loaded before your handler with NODE_OPTIONS="--import ./otel.mjs"
import { register } from 'node:module';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { registerInstrumentations } from '@opentelemetry/instrumentation';

register('@opentelemetry/instrumentation/hook.mjs', import.meta.url); // the handler is an ES module

// Name the service after the function unless OTEL_SERVICE_NAME is set.
process.env.OTEL_SERVICE_NAME ??= process.env.AWS_LAMBDA_FUNCTION_NAME;

const instrumentations = getNodeAutoInstrumentations();
new NodeSDK({ instrumentations }).start();
// Register again now that the SDK has started, so the Lambda instrumentation
// flushes spans, logs and metrics before each invocation returns.
registerInstrumentations({ instrumentations });`;

  const nodeLambdaHandler = `import { trace, metrics } from '@opentelemetry/api';
import pino from 'pino';

const logger = pino();
const orders = metrics.getMeter('orders').createCounter('orders.placed');

export const handler = async (event) => {
  // The invocation span is created for you; add your own attributes to it.
  trace.getActiveSpan()?.setAttribute('order.items', event.items);
  orders.add(1, { plan: 'pro' });
  logger.info({ items: event.items }, 'order placed');
  return { statusCode: 200, body: 'ok' };
};`;

  const nodeLambdaSam = `OrdersFunction:
  Type: AWS::Serverless::Function
  Properties:
    Runtime: nodejs24.x
    Handler: index.handler
    CodeUri: orders/
    Environment:
      Variables:
        NODE_OPTIONS: --import ./otel.mjs
        OTEL_EXPORTER_OTLP_ENDPOINT: ${origin}
        OTEL_EXPORTER_OTLP_HEADERS: x-wgo-key=${KEY}
        OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: delta
        # Load only what the function uses; each instrumentation adds to cold starts.
        OTEL_NODE_ENABLED_INSTRUMENTATIONS: aws-lambda,aws-sdk,http,undici,pino`;

  const pyServerApp = `import logging
from flask import Flask
from opentelemetry import trace, metrics

app = Flask(__name__)
log = logging.getLogger(__name__)
tracer = trace.get_tracer("shop")
orders = metrics.get_meter("shop").create_counter("orders.placed")

@app.post("/orders")
def place_order():
    with tracer.start_as_current_span("place-order") as span:
        span.set_attribute("order.items", 3)
        orders.add(1, {"plan": "pro"})
        log.warning("order placed")  # standard logging is sent to WGO too
    return "ok"`;

  const pyLambdaTelemetry = `"""OpenTelemetry for a Python Lambda function. Import this before anything else in your handler module."""
import functools
import os

from opentelemetry import _logs, metrics, trace
from opentelemetry.instrumentation.auto_instrumentation import initialize

# Name the service after the function unless OTEL_SERVICE_NAME is set.
os.environ.setdefault("OTEL_SERVICE_NAME", os.environ["AWS_LAMBDA_FUNCTION_NAME"])

initialize()  # same as running under opentelemetry-instrument: reads the OTEL_* variables

_tracer = trace.get_tracer(__name__)


def instrumented(handler):
    """Wrap each invocation in a span and send all telemetry before Lambda freezes the process."""

    @functools.wraps(handler)
    def wrapper(event, context):
        try:
            with _tracer.start_as_current_span(
                context.function_name,
                kind=trace.SpanKind.SERVER,
                attributes={"faas.invocation_id": context.aws_request_id},
            ):
                return handler(event, context)
        finally:
            trace.get_tracer_provider().force_flush()
            metrics.get_meter_provider().force_flush()
            _logs.get_logger_provider().force_flush()

    return wrapper`;

  const pyLambdaHandler = `from telemetry import instrumented  # first, so libraries imported below are instrumented

import logging

from opentelemetry import metrics, trace

log = logging.getLogger()
log.setLevel(logging.INFO)
orders = metrics.get_meter("orders").create_counter("orders.placed")


@instrumented
def handler(event, context):
    trace.get_current_span().set_attribute("order.items", event["items"])
    orders.add(1, {"plan": "pro"})
    log.info("order placed")
    return {"statusCode": 200, "body": "ok"}`;

  const pyLambdaSam = `OrdersFunction:
  Type: AWS::Serverless::Function
  Properties:
    Runtime: python3.13
    Handler: handler.handler
    CodeUri: orders/
    Environment:
      Variables:
        OTEL_EXPORTER_OTLP_ENDPOINT: ${origin}
        OTEL_EXPORTER_OTLP_HEADERS: x-wgo-key=${KEY}
        OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf
        OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: delta`;

  return (
    <div className="bg-atmos h-full overflow-y-auto">
      <SiteHeader />

      <div className="mx-auto grid grid-cols-1 max-w-[1200px] gap-12 px-6 pb-24 pt-14 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav className="hidden lg:block">
          <div className="sticky top-28 space-y-1 text-[13px]">
            <p className="mb-3 text-[12px] font-medium text-faint">On this page</p>
            {SECTIONS.map(([id, t]) => <button key={id} onClick={() => scrollTo(id)} className="block w-full cursor-pointer rounded-md px-2 py-1 text-left text-muted hover:bg-[var(--hl)] hover:text-fg">{t}</button>)}
          </div>
        </nav>

        <main className="max-w-[780px] space-y-12">
          <div>
            <h1 className="text-[34px] font-semibold leading-tight tracking-tight">Send OpenTelemetry data from your backend</h1>
            <p className="mt-4 text-[16px] leading-relaxed text-muted">
              WGO accepts traces, metrics and logs over OTLP/HTTP, so any OpenTelemetry SDK or Collector can send to it. This guide sets up
              Node.js and Python services, both on long-running servers and on AWS Lambda, where telemetry has to be sent before each invocation ends.
            </p>
          </div>

          <Section id="connect" title="Connection settings">
            <P>Every example below is configured with the same environment variables. Replace <C>{KEY}</C> with your project's write key, which you'll find in the dashboard under <span className="text-fg">Settings → Install</span>.</P>
            <Code lang="sh" title="Environment" code={env} />
            <ul className="space-y-2.5 text-[14px] leading-relaxed text-muted">
              <li><span className="text-fg">Endpoint:</span> the base URL only. The SDKs add <C>/v1/traces</C>, <C>/v1/metrics</C> and <C>/v1/logs</C> themselves. If you set a URL on an exporter in code, include that path.</li>
              <li><span className="text-fg">Write key:</span> send it in the <C>x-wgo-key</C> header. CloudFront doesn't forward the <C>Authorization</C> header, so a bearer token won't reach WGO.</li>
              <li><span className="text-fg">Protocol:</span> <C>http/protobuf</C> or <C>http/json</C>, optionally gzipped. gRPC isn't supported.</li>
              <li><span className="text-fg">Service name:</span> <C>OTEL_SERVICE_NAME</C> is how a service is labelled on the Traces, Logs and Metrics pages. The Lambda setups below default it to the function name.</li>
            </ul>
          </Section>

          <Section id="node-server" title="Node.js on a server">
            <P>For a process that keeps running, such as an Express or Fastify app on EC2, ECS or Kubernetes, the zero-code setup is enough: no changes to your code.</P>
            <Step title="1. Install the packages">
              <Code lang="sh" title="Terminal" code="npm install @opentelemetry/api @opentelemetry/auto-instrumentations-node" />
            </Step>
            <Step title="2. Start your app with the SDK loaded">
              <Code lang="sh" title="Terminal" code="node --require @opentelemetry/auto-instrumentations-node/register app.js" />
              <P>With the connection settings in the environment, this records incoming and outgoing HTTP requests, popular frameworks and database clients, and sends pino and bunyan logs, linked to the trace they happened in. For winston logs, also install <C>@opentelemetry/winston-transport</C>. When the process gets <C>SIGTERM</C>, the SDK sends whatever it still has buffered. Its signal listener also turns off Node's default exit on <C>SIGTERM</C>, so if your app doesn't handle that signal yet, add a handler that closes the server and exits.</P>
              <P>If your app is written as ES modules, also pass <C>--experimental-loader=@opentelemetry/instrumentation/hook.mjs</C> so libraries loaded with <C>import</C> get instrumented.</P>
            </Step>
            <Step title="3. Add your own spans and metrics">
              <P>Use <C>@opentelemetry/api</C> anywhere in your code. It picks up the SDK started by the flag above.</P>
              <Code lang="js" title="app.js" code={nodeServerApp} />
            </Step>
          </Section>

          <Section id="node-lambda" title="Node.js on AWS Lambda">
            <P>Lambda freezes the process as soon as your handler returns, so anything the SDK hasn't sent yet waits until the next invocation, or is lost when the instance shuts down. The setup below sends spans, logs and metrics before each invocation returns.</P>
            <Step title="1. Install the packages in the function's folder">
              <Code lang="sh" title="Terminal" code="npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node @opentelemetry/instrumentation" />
              <P>Deploy <C>node_modules</C> as is. If you bundle the function with esbuild or webpack, the instrumentations can't hook into the libraries inside the bundle.</P>
            </Step>
            <Step title="2. Add a setup file next to your handler">
              <Code lang="js" title="otel.mjs" code={nodeLambdaOtel} />
              <P>The service is named after the function (<C>AWS_LAMBDA_FUNCTION_NAME</C>); set <C>OTEL_SERVICE_NAME</C> on the function to use a different name.</P>
              <P>The second <C>registerInstrumentations</C> call matters. The Lambda instrumentation looks for the trace and log providers when it's registered, and <C>NodeSDK</C> creates them only afterwards. Without the call, spans and logs are sent on a timer that doesn't run while the function is frozen.</P>
            </Step>
            <Step title="3. Write the handler as usual">
              <Code lang="js" title="index.mjs" code={nodeLambdaHandler} />
            </Step>
            <Step title="4. Configure the function">
              <Code lang="yaml" title="template.yaml (AWS SAM)" code={nodeLambdaSam} />
              <P>Delta temporality makes each metric point the change since the last export. Every Lambda instance counts from zero, so cumulative totals from many instances can't be added up, while delta points can be summed on the Metrics page.</P>
            </Step>
          </Section>

          <Section id="python-server" title="Python on a server">
            <P>For Flask, Django, FastAPI and other long-running apps, <C>opentelemetry-instrument</C> sets up the SDK and instruments the libraries you use without code changes.</P>
            <Step title="1. Install the packages">
              <Code lang="sh" title="Terminal" code={'pip install opentelemetry-distro opentelemetry-exporter-otlp-proto-http\nopentelemetry-bootstrap -a install  # adds instrumentations for the libraries you have installed'} />
            </Step>
            <Step title="2. Start your app through opentelemetry-instrument">
              <Code lang="sh" title="Terminal" code="opentelemetry-instrument flask --app app run" />
              <P>Put <C>opentelemetry-instrument</C> in front of whatever command starts your app. Keep <C>OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf</C> in the environment: the Python distribution defaults to gRPC, which WGO doesn't accept. Records from the standard <C>logging</C> module are sent too, with their trace and span IDs.</P>
              <P>With gunicorn or uWSGI worker processes, set the SDK up in a post-fork hook instead. See <Ext href="https://opentelemetry-python.readthedocs.io/en/latest/examples/fork-process-model/README.html">working with fork process models</Ext> in the OpenTelemetry Python docs.</P>
            </Step>
            <Step title="3. Add your own spans and metrics">
              <Code lang="py" title="app.py" code={pyServerApp} />
            </Step>
          </Section>

          <Section id="python-lambda" title="Python on AWS Lambda">
            <P>As with Node.js, telemetry has to be sent before the handler returns. A small module sets up the SDK once per instance and wraps the handler so every invocation gets a span and a flush.</P>
            <Step title="1. List the packages">
              <Code lang="sh" title="requirements.txt" code={'opentelemetry-distro\nopentelemetry-exporter-otlp-proto-http\nopentelemetry-instrumentation-logging\nopentelemetry-instrumentation-botocore'} />
              <P>Install them into the function package with <C>sam build</C> or <C>pip install -r requirements.txt -t .</C>. Build on Linux, or with <C>sam build --use-container</C>, because protobuf ships compiled wheels that must match the Lambda runtime.</P>
            </Step>
            <Step title="2. Add the setup module">
              <Code lang="py" title="telemetry.py" code={pyLambdaTelemetry} />
              <P>As on Node.js, the service is named after the function unless you set <C>OTEL_SERVICE_NAME</C>.</P>
            </Step>
            <Step title="3. Decorate your handler">
              <Code lang="py" title="handler.py" code={pyLambdaHandler} />
            </Step>
            <Step title="4. Configure the function">
              <Code lang="yaml" title="template.yaml (AWS SAM)" code={pyLambdaSam} />
            </Step>
          </Section>

          <Section id="check" title="Checking that it works">
            <P>Send a few requests, then open your project's <span className="text-fg">Traces</span>, <span className="text-fg">Logs</span> and <span className="text-fg">Metrics</span> pages. Services show up under the name you set in <C>OTEL_SERVICE_NAME</C>, or the function name on Lambda. Server SDKs send in batches, so allow a few seconds.</P>
            <P>If nothing arrives, set <C>OTEL_LOG_LEVEL=debug</C> (Node.js) to see the exporter's requests. WGO queues each request and checks the write key afterwards, so a missing or wrong key doesn't cause an error response: the data just never appears. Check that the key is in <C>OTEL_EXPORTER_OTLP_HEADERS</C> as <C>x-wgo-key=…</C>. Requests over about 750 KB are rejected with <C>400</C>; gzip compression or smaller batches keep them under the limit.</P>
          </Section>
        </main>
      </div>
      <SiteFooter />
    </div>
  );
}
