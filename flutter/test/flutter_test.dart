import 'package:flutter/foundation.dart';
// material_ui replaces it from Flutter 3.47; the SDK supports older Flutter, where it doesn't exist yet
// ignore: deprecated_member_use
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:wgo_flutter/src/device.dart';
import 'package:wgo_flutter/wgo_flutter.dart';

import 'helpers.dart';

Future<FakeIngest> start({WgoConfig? config}) async {
  final ingest = FakeIngest();
  await Wgo.init(config ?? cfg(), storage: MemoryStorage(), httpClient: ingest.client);
  return ingest;
}

/// Sends what's queued and stops, so no timers or error handlers outlive the test.
Future<void> finish() async {
  await Wgo.flush();
  await Wgo.shutdown();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('calls made before init are replayed once it finishes', () async {
    Wgo.identify('early');
    Wgo.track('early_event');
    final ingest = await start();
    await finish();
    expect(ingest.events.map((e) => e['t']), ['identify', 'custom']);
    expect(ingest.events.last['u'], 'early');
    expect(ingest.batches.single['ctx']['sdk'], 'wgo-flutter/0.1.0');
  });

  test('init twice is ignored; status reports the client', () async {
    final ingest = await start();
    await Wgo.init(cfg(), storage: MemoryStorage(), httpClient: FakeIngest().client);
    Wgo.track('x');
    expect(Wgo.status(), {'initialized': true, 'endpoint': endpoint, 'queued': 1});
    await finish();
    expect(ingest.events, hasLength(1));
    expect(Wgo.status()['initialized'], isFalse);
  });

  test('reports Flutter and platform errors and still calls the earlier handlers', () async {
    final seen = <String>[];
    final prevFlutter = FlutterError.onError;
    final prevPlatform = PlatformDispatcher.instance.onError;
    FlutterError.onError = (d) => seen.add('flutter: ${d.exceptionAsString()}');
    PlatformDispatcher.instance.onError = (e, s) {
      seen.add('platform: $e');
      return true;
    };
    try {
      final ingest = await start();
      FlutterError.onError!(FlutterErrorDetails(
        exception: StateError('layout broke'),
        stack: StackTrace.fromString('#0      Foo.build (package:app/foo.dart:3:9)'),
      ));
      final handled = PlatformDispatcher.instance.onError!(Exception('async boom'), StackTrace.empty);
      expect(handled, isTrue, reason: 'the earlier handler decides');
      await finish();
      expect(seen, ['flutter: Bad state: layout broke', 'platform: Exception: async boom']);
      final errors = ingest.ofType('error');
      expect(errors.map((e) => e['d']['msg']), ['Bad state: layout broke', 'Exception: async boom']);
      expect(errors.first['d']['src'], 'package:app/foo.dart');
      expect(errors.first['d']['kind'], 'error');
      // shutdown put the earlier handlers back
      FlutterError.onError!(FlutterErrorDetails(exception: Exception('after')));
      expect(seen.last, 'flutter: Exception: after');
    } finally {
      FlutterError.onError = prevFlutter;
      PlatformDispatcher.instance.onError = prevPlatform;
    }
  });

  testWidgets('the navigator observer reports page routes, not dialogs or unnamed routes', (tester) async {
    final ingest = await tester.runAsync(() => start());
    final nav = GlobalKey<NavigatorState>();
    await tester.pumpWidget(MaterialApp(
      navigatorKey: nav,
      navigatorObservers: [WgoNavigatorObserver()],
      initialRoute: '/',
      routes: {
        '/': (_) => const Text('home'),
        '/settings': (_) => const Text('settings'),
      },
    ));
    nav.currentState!.pushNamed('/settings');
    await tester.pumpAndSettle();
    showDialog<void>(context: nav.currentContext!, builder: (_) => const Text('dialog'));
    await tester.pumpAndSettle();
    nav.currentState!.pop(); // the dialog
    await tester.pumpAndSettle();
    nav.currentState!.push(MaterialPageRoute<void>(builder: (_) => const Text('anonymous')));
    await tester.pumpAndSettle();
    nav.currentState!.pop();
    await tester.pumpAndSettle();
    nav.currentState!.pop(); // back to home
    await tester.pumpAndSettle();
    await tester.runAsync(finish);
    final views = ingest!.ofType('pageview');
    expect(views.map((e) => e['path']), ['/', '/settings', '/settings', '/']);
    expect(views[1]['ref'], 'app:/');
  });

  testWidgets('WgoTrack reports taps without getting in the way, and ignores drags', (tester) async {
    final ingest = await tester.runAsync(() => start());
    var pressed = 0;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Center(
          child: WgoTrack(
            name: 'buy',
            label: 'Buy now',
            child: ElevatedButton(onPressed: () => pressed++, child: const Text('Buy now')),
          ),
        ),
      ),
    ));
    await tester.tap(find.text('Buy now'));
    await tester.drag(find.text('Buy now'), const Offset(0, 200));
    await tester.pump();
    await tester.runAsync(finish);
    expect(pressed, 1);
    final click = ingest!.ofType('click').single['d'] as Map;
    expect(click['name'], 'buy');
    expect(click['text'], 'Buy now');
    expect(click['tag'], 'ElevatedButton');
    expect(click['vw'], 800);
    expect(click['x'], 400);
  });

  test('WgoHttpClient sends traceparent and reports failed requests with it', () async {
    final ingest = await start();
    final seen = <http.BaseRequest>[];
    final api = WgoHttpClient(
      inner: MockClient((req) async {
        seen.add(req);
        if (req.url.path == '/down') throw http.ClientException('no route', req.url);
        return http.Response('', req.url.path == '/fail' ? 500 : 200, reasonPhrase: 'Internal Server Error');
      }),
    );
    await api.get(Uri.parse('https://api.example.com/ok'));
    await api.post(Uri.parse('https://api.example.com/fail?secret=1'));
    await expectLater(api.get(Uri.parse('https://api.example.com/down')), throwsA(isA<http.ClientException>()));
    await api.get(Uri.parse('https://api.example.com/own'), headers: {'traceparent': 'mine'});
    await finish();

    expect(seen[0].headers['traceparent'], matches(RegExp(r'^00-[0-9a-f]{32}-[0-9a-f]{16}-01$')));
    expect(seen[3].headers['traceparent'], 'mine');
    final failed = ingest.ofType('http_error');
    expect(failed, hasLength(2));
    final d = failed[0]['d'] as Map;
    expect(d['method'], 'POST');
    expect(d['url'], 'https://api.example.com/fail');
    expect(d['status'], 500);
    expect(d['statusText'], 'Internal Server Error');
    expect(seen[1].headers['traceparent'], '00-${d['trace']}-${d['span']}-01');
    expect(failed[1]['d']['status'], 0);
    expect(failed[1]['d']['statusText'], 'ClientException');
  }, testOn: '!browser'); // on the web these cross-origin requests get no traceparent (see client_test.dart)

  test('WgoHttpClient passes requests through before init', () async {
    http.BaseRequest? sent;
    final api = WgoHttpClient(inner: MockClient((req) async {
      sent = req;
      return http.Response('', 500);
    }));
    final res = await api.get(Uri.parse('https://api.example.com/x'));
    expect(res.statusCode, 500);
    expect(sent!.headers.containsKey('traceparent'), isFalse);
  });

  test('the user agent names the platform and phone or tablet the way the backend parses it', () {
    String? ua(TargetPlatform p, {bool tablet = false}) {
      debugDefaultTargetPlatformOverride = p;
      try {
        return userAgent(tablet: tablet);
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    }

    expect(ua(TargetPlatform.android), 'wgo-flutter/0.1.0 (Linux; Android; Mobile)');
    expect(ua(TargetPlatform.android, tablet: true), 'wgo-flutter/0.1.0 (Linux; Android)');
    expect(ua(TargetPlatform.iOS), 'wgo-flutter/0.1.0 (iPhone; iOS)');
    expect(ua(TargetPlatform.iOS, tablet: true), 'wgo-flutter/0.1.0 (iPad; iOS)');
    expect(ua(TargetPlatform.macOS), 'wgo-flutter/0.1.0 (Macintosh; Mac OS X)');
    final ctx = deviceContext();
    expect(ctx['lang'], isA<String>());
    expect(ctx['sw'], isA<int>());
  }, testOn: '!browser');

  test('on the web the backend reads the browser\'s own user agent', () {
    expect(userAgent(tablet: false), isNull);
    expect(deviceContext().containsKey('ua'), isFalse);
  }, testOn: 'browser');
}
