import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wgo_flutter/wgo_flutter.dart';

import 'helpers.dart';

class _Json {
  Map<String, Object?> toJson() => {'at': DateTime.utc(2026)};
}

final _uuid = RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');

void main() {
  group('delivery', () {
    test('sends a batch in the wire format after flushInterval, not before', () {
      fakeAsync((fa) {
        final ingest = FakeIngest();
        final c = newClient(ingest, config: cfg());
        c.track('signup', {'plan': 'pro'});
        fa.elapse(const Duration(milliseconds: 4900));
        expect(ingest.requests, isEmpty);
        fa.elapse(const Duration(milliseconds: 200));
        expect(ingest.requests, hasLength(1));
        final req = ingest.requests.single;
        expect(req.url.toString(), '$endpoint/ingest');
        expect(req.headers['content-type'], 'text/plain;charset=UTF-8');
        final b = ingest.batches.single;
        expect(b['k'], 'wk_test');
        expect(b['a'], matches(_uuid));
        expect(b['sentAt'], isA<int>());
        expect(b['ctx'], {'ua': 'test', 'sdk': 'wgo-flutter/0.1.0', 'release': '1.2.3'});
        final e = (b['e'] as List).single as Map;
        expect(e['t'], 'custom');
        expect(e['id'], matches(_uuid));
        expect(e['s'], matches(_uuid));
        expect(e['url'], 'app:/');
        expect(e['path'], '/');
        expect(e['d'], {'name': 'signup', 'props': {'plan': 'pro'}});
        expect(e.containsKey('u'), isFalse);
      });
    });

    test('an error pulls the deadline in; later normal events never push it out', () {
      fakeAsync((fa) {
        final ingest = FakeIngest();
        final c = newClient(ingest, config: cfg());
        c.track('a');
        fa.elapse(const Duration(seconds: 3));
        c.captureException(StateError('boom'));
        fa.elapse(const Duration(milliseconds: 500));
        c.track('b');
        fa.elapse(const Duration(milliseconds: 600));
        expect(ingest.events.map((e) => e['t']), ['custom', 'error', 'custom']);
      });
    });

    test('a full batch is sent at once and split at maxBatchSize', () {
      fakeAsync((fa) {
        final ingest = FakeIngest();
        final c = newClient(ingest, config: cfg(maxBatchSize: 3));
        for (var i = 0; i < 7; i++) {
          c.track('e$i');
        }
        fa.flushMicrotasks();
        fa.elapse(Duration.zero);
        expect(ingest.batches.map((b) => (b['e'] as List).length).take(2), [3, 3]);
        fa.elapse(const Duration(seconds: 5));
        expect(ingest.events, hasLength(7));
      });
    });

    test('retries 5xx, 429 and network errors with backoff; drops other 4xx', () {
      fakeAsync((fa) {
        final codes = [503, 429, -1, 202, 400];
        final ingest = FakeIngest(status: (i) => codes[i]);
        final c = newClient(ingest, config: cfg());
        c.track('x');
        fa.elapse(const Duration(seconds: 5));
        expect(ingest.requests, hasLength(1));
        fa.elapse(const Duration(milliseconds: 1300)); // 1s backoff (+ up to 20% jitter)
        expect(ingest.requests, hasLength(2));
        fa.elapse(const Duration(milliseconds: 2500)); // 2s
        expect(ingest.requests, hasLength(3));
        fa.elapse(const Duration(seconds: 5)); // 4s
        expect(ingest.requests, hasLength(4));
        expect(ingest.events, hasLength(1));
        expect(c.queued, 0);
        c.track('y');
        fa.elapse(const Duration(seconds: 6));
        expect(ingest.requests, hasLength(5));
        fa.elapse(const Duration(minutes: 5));
        expect(ingest.requests, hasLength(5), reason: 'a 400 is not retried');
      });
    });

    test('gives up on a batch after maxRetries', () {
      fakeAsync((fa) {
        final ingest = FakeIngest(status: (_) => 500);
        final c = newClient(ingest, config: cfg(maxRetries: 2));
        c.track('x');
        fa.elapse(const Duration(minutes: 2));
        expect(ingest.requests, hasLength(3));
        expect(c.queued, 0);
      });
    });

    test('gzips batches over 1 KB', () {
      fakeAsync((fa) {
        final ingest = FakeIngest();
        final c = newClient(ingest, config: cfg());
        c.track('big', {'blob': 'x' * 2000});
        fa.elapse(const Duration(seconds: 5));
        final req = ingest.requests.single;
        expect(req.headers['content-type'], 'application/octet-stream');
        expect(req.bodyBytes.take(2), [0x1f, 0x8b]);
        expect(ingest.ofType('custom').single['d']['props']['blob'], hasLength(2000));
      });
    }, testOn: '!browser');

    test('sends uncompressed on the web', () {
      fakeAsync((fa) {
        final ingest = FakeIngest();
        newClient(ingest, config: cfg()).track('big', {'blob': 'x' * 2000});
        fa.elapse(const Duration(seconds: 5));
        expect(ingest.requests.single.headers['content-type'], 'text/plain;charset=UTF-8');
      });
    }, testOn: 'browser');

    test('keeps unsent events on the device and sends them on the next start', () {
      fakeAsync((fa) {
        final store = MemoryStorage();
        final down = FakeIngest(status: (_) => -1);
        final c = newClient(down, storage: store, config: cfg());
        c.track('offline');
        fa.elapse(const Duration(seconds: 2));
        expect(store.get('wgo:q:wk_test'), contains('offline'));
        fa.elapse(const Duration(seconds: 4)); // the send fails: queued for a retry
        expect(down.requests, hasLength(1));
        c.shutdown();
        fa.flushMicrotasks();
        expect(store.get('wgo:q:wk_test'), contains('offline'));

        final up = FakeIngest();
        final c2 = newClient(up, storage: store, config: cfg());
        fa.elapse(Duration.zero);
        expect(up.ofType('custom').single['d']['name'], 'offline');
        expect(up.batches.single['a'], c2.session.aid);
        fa.elapse(const Duration(seconds: 2));
        expect(store.get('wgo:q:wk_test'), isNull);
      });
    });

    test('memoryOnly writes nothing to the device', () {
      fakeAsync((fa) {
        final store = MemoryStorage();
        final c = newClient(FakeIngest(status: (_) => -1), storage: store, config: cfg(memoryOnly: true));
        c.identify('u1');
        c.screen('/home');
        c.paused();
        fa.elapse(const Duration(seconds: 10));
        for (final k in ['wgo:aid', 'wgo:uid', 'wgo:sid', 'wgo:q:wk_test']) {
          expect(store.get(k), isNull, reason: k);
        }
      });
    });

    test('shutdown sends what is queued and stops', () {
      fakeAsync((fa) {
        final ingest = FakeIngest();
        final c = newClient(ingest, config: cfg());
        c.track('last');
        c.shutdown();
        fa.flushMicrotasks();
        expect(ingest.ofType('custom'), hasLength(1));
        c.track('after');
        fa.elapse(const Duration(seconds: 10));
        expect(ingest.requests, hasLength(1));
      });
    });
  });

  group('users and sessions', () {
    test('identify attaches u from then on and survives a restart; reset starts a new visitor', () {
      fakeAsync((fa) {
        final store = MemoryStorage();
        final ingest = FakeIngest();
        final c = newClient(ingest, storage: store, config: cfg());
        final anon = c.session.aid;
        c.track('before');
        c.identify('user_42', {'plan': 'pro'});
        c.track('after');
        fa.elapse(const Duration(seconds: 6)); // sent, and the device copy of the queue cleared
        final ev = ingest.events;
        expect(ev[0].containsKey('u'), isFalse);
        expect(ev[1]['t'], 'identify');
        expect(ev[1]['d'], {'traits': {'plan': 'pro'}});
        expect(ev.skip(1).map((e) => e['u']), ['user_42', 'user_42']);

        final c2 = newClient(ingest, storage: store, config: cfg());
        expect(c2.session.uid, 'user_42');
        expect(c2.session.aid, anon);
        expect(c2.session.manual, isTrue);

        c2.track('queued as user');
        c2.reset();
        c2.track('new visitor');
        fa.elapse(const Duration(seconds: 6));
        final last = ingest.batches.skip(1).toList();
        expect(last, hasLength(2), reason: 'one batch per anonymous id');
        expect(last[0]['a'], anon);
        expect(last[0]['e'][0]['u'], 'user_42');
        expect(last[1]['a'], isNot(anon));
        expect((last[1]['e'][0] as Map).containsKey('u'), isFalse);
        expect(last[1]['e'][0]['s'], isNot(last[0]['e'][0]['s']));
      });
    });

    test('a new session starts after sessionTimeout of inactivity', () {
      fakeAsync((fa) {
        final ingest = FakeIngest();
        final c = newClient(ingest, config: cfg());
        c.track('a');
        fa.elapse(const Duration(minutes: 29));
        c.track('b');
        fa.elapse(const Duration(minutes: 31));
        c.track('c');
        fa.elapse(const Duration(seconds: 5));
        final s = ingest.events.map((e) => e['s']).toList();
        expect(s[0], s[1]);
        expect(s[2], isNot(s[1]));
      });
    });

    test('coming back after the timeout views the current screen again in the new session', () {
      fakeAsync((fa) {
        final ingest = FakeIngest();
        final c = newClient(ingest, config: cfg());
        c.screen('/cart');
        c.paused();
        fa.elapse(const Duration(minutes: 5));
        c.resumed();
        fa.elapse(const Duration(minutes: 40));
        c.resumed();
        fa.elapse(const Duration(seconds: 5));
        final views = ingest.ofType('pageview');
        expect(views, hasLength(2));
        expect(views[1]['path'], '/cart');
        expect(views[1]['s'], isNot(views[0]['s']));
        expect(views[1].containsKey('ref'), isFalse);
      });
    });

    test('sampleRate 0 sends nothing', () {
      fakeAsync((fa) {
        final ingest = FakeIngest();
        final c = newClient(ingest, config: cfg(sampleRate: 0));
        c.screen('/');
        c.track('x');
        fa.elapse(const Duration(seconds: 10));
        expect(ingest.requests, isEmpty);
      });
    });
  });

  group('events', () {
    test('screens set path, url and ref; query strings are stripped by default', () {
      fakeAsync((fa) {
        final ingest = FakeIngest();
        final c = newClient(ingest, config: cfg());
        c.screen('/');
        c.screen('product/42?ref=mail#top', title: 'Product');
        c.track('add_to_cart');
        fa.elapse(const Duration(seconds: 5));
        final [home, product, custom] = ingest.events;
        expect(home['url'], 'app:/');
        expect(home.containsKey('ref'), isFalse);
        expect(product['path'], '/product/42');
        expect(product['url'], 'app:/product/42#top');
        expect(product['ref'], 'app:/');
        expect(product['title'], 'Product');
        expect(custom['path'], '/product/42');
        expect(custom.containsKey('ref'), isFalse);
      });
    });

    test('captureQueryParams keeps them', () {
      fakeAsync((fa) {
        final ingest = FakeIngest();
        newClient(ingest, config: cfg(captureQueryParams: true)).screen('/search?q=shoes');
        fa.elapse(const Duration(seconds: 5));
        expect(ingest.events.single['url'], 'app:/search?q=shoes');
        expect(ingest.events.single['path'], '/search');
      });
    });

    test('beforeSend can change and drop events; a throwing hook keeps the event', () {
      fakeAsync((fa) {
        final ingest = FakeIngest();
        final c = newClient(ingest, config: cfg(beforeSend: (e) {
          if (e.data?['name'] == 'drop') return null;
          if (e.data?['name'] == 'throw') throw Exception('hook');
          return e..title = 'changed';
        }));
        c.track('keep');
        c.track('drop');
        c.track('throw');
        fa.elapse(const Duration(seconds: 5));
        expect(ingest.events.map((e) => e['d']['name']), ['keep', 'throw']);
        expect(ingest.events.first['title'], 'changed');
      });
    });

    test('values JSON cannot hold are sent as strings', () {
      fakeAsync((fa) {
        final ingest = FakeIngest();
        newClient(ingest, config: cfg()).track('x', {
          'at': DateTime.utc(2026),
          'set': {1, 2},
          'nan': double.nan,
          'json': _Json(),
          'object': Object(),
        });
        fa.elapse(const Duration(seconds: 5));
        expect(ingest.events.single['d']['props'], {
          'at': '2026-01-01T00:00:00.000Z',
          'set': [1, 2],
          'nan': 'NaN',
          'json': {'at': '2026-01-01T00:00:00.000Z'},
          'object': "Instance of 'Object'",
        });
      });
    });
  });

  group('errors', () {
    const stack = '#0      CartPage.checkout (package:shop/cart.dart:42:7)\n'
        '#1      _InkResponseState.handleTap (package:flutter/src/material/ink_well.dart:1170:21)';

    test('reports message, Dart stack and its first frame', () {
      fakeAsync((fa) {
        final ingest = FakeIngest();
        final c = newClient(ingest, config: cfg());
        c.captureException(StateError('cart empty'), StackTrace.fromString(stack), {'orderId': 7});
        fa.elapse(const Duration(seconds: 1));
        final d = ingest.ofType('error').single['d'];
        expect(d, {
          'msg': 'Bad state: cart empty',
          'kind': 'manual',
          'stack': stack,
          'src': 'package:shop/cart.dart',
          'line': 42,
          'col': 7,
          'extra': {'orderId': 7},
        });
      });
    });

    test('uses an Error\'s own stack trace when none is passed', () {
      fakeAsync((fa) {
        final ingest = FakeIngest();
        final c = newClient(ingest, config: cfg());
        try {
          throw ArgumentError('bad');
        } catch (e) {
          c.captureException(e);
        }
        fa.elapse(const Duration(seconds: 1));
        expect(ingest.ofType('error').single['d']['stack'], contains('client_test.dart'));
      });
    });

    test('identical errors within 5 s become one event with a count; at most 30 a minute', () {
      fakeAsync((fa) {
        final ingest = FakeIngest();
        final c = newClient(ingest, config: cfg());
        for (var i = 0; i < 3; i++) {
          c.reportError('same', stack: stack);
        }
        for (var i = 0; i < 40; i++) {
          c.reportError('distinct $i');
        }
        fa.elapse(const Duration(seconds: 2));
        final errors = ingest.ofType('error');
        expect(errors.first['d']['count'], 3);
        expect(errors, hasLength(30));
      });
    });
  });

  group('taps', () {
    test('three taps within a second are one rage click', () {
      fakeAsync((fa) {
        final ingest = FakeIngest();
        final c = newClient(ingest, config: cfg());
        c.screen('/checkout');
        c.tap('pay', name: 'pay', label: 'Pay now', tag: 'FilledButton', x: 10.4, y: 20.6, width: 400, height: 800);
        fa.elapse(const Duration(milliseconds: 200));
        c.tap('pay');
        fa.elapse(const Duration(milliseconds: 200));
        c.tap('pay');
        c.tap('pay');
        fa.elapse(const Duration(seconds: 5));
        final clicks = ingest.ofType('click');
        expect(clicks, hasLength(3));
        expect(clicks.first['d'], {
          'sel': 'pay', 'tag': 'FilledButton', 'name': 'pay', 'text': 'Pay now', 'x': 10, 'y': 21, 'vw': 400, 'vh': 800,
        });
        expect(clicks[2]['d']['rage'], 4);
        expect(clicks.first['path'], '/checkout');
      });
    });
  });

  group('requests', () {
    test('traceparent is a sampled W3C header, limited by traceOrigins and never for the SDK itself', () {
      final c = newClient(FakeIngest(), config: cfg());
      expect(c.traceparent('https://api.example.com/x'), matches(RegExp(r'^00-[0-9a-f]{32}-[0-9a-f]{16}-01$')));
      expect(c.traceparent('$endpoint/ingest'), isNull);
      final only = newClient(FakeIngest(), config: cfg(traceOrigins: ['https://api.example.com/']));
      expect(only.traceparent('https://api.example.com/x'), isNotNull);
      expect(only.traceparent('https://cdn.example.com/x'), isNull);
      expect(newClient(FakeIngest(), config: cfg(tracePropagation: false)).traceparent('https://a/'), isNull);
    }, testOn: '!browser');

    test('on the web, traceparent is same-origin only until traceOrigins is set', () {
      final c = newClient(FakeIngest(), config: cfg());
      expect(c.traceparent(Uri.base.resolve('/api/x').toString()), isNotNull);
      expect(c.traceparent('/api/x'), isNotNull);
      expect(c.traceparent('https://api.example.com/x'), isNull);
      final listed = newClient(FakeIngest(), config: cfg(traceOrigins: ['https://api.example.com/']));
      expect(listed.traceparent('https://api.example.com/x'), isNotNull);
    }, testOn: 'browser');

    test('captureHttpError reports method, clean url, status, duration and trace; ignores httpIgnore', () {
      fakeAsync((fa) {
        final ingest = FakeIngest();
        final c = newClient(ingest, config: cfg(httpIgnore: [RegExp(r'/health$')]));
        c.captureHttpError(
          method: 'post',
          url: 'https://api.example.com/orders?token=secret',
          status: 503,
          statusText: 'Service Unavailable',
          duration: const Duration(milliseconds: 120),
          traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        );
        c.captureHttpError(method: 'GET', url: 'https://api.example.com/health', status: 500);
        c.captureHttpError(method: 'GET', url: '$endpoint/ingest', status: 500);
        fa.elapse(const Duration(seconds: 1));
        expect(ingest.ofType('http_error').single['d'], {
          'method': 'POST',
          'url': 'https://api.example.com/orders',
          'status': 503,
          'statusText': 'Service Unavailable',
          'dur': 120,
          'kind': 'dart',
          'trace': '0af7651916cd43dd8448eb211c80319c',
          'span': 'b7ad6b7169203331',
        });
      });
    });
  });

  test('persisted queue entries keep their anonymous id', () {
    fakeAsync((fa) {
      final store = MemoryStorage();
      final c = newClient(FakeIngest(status: (_) => -1), storage: store, config: cfg());
      c.track('x');
      c.paused();
      fa.flushMicrotasks(); // the send failed and the event waits for a retry
      final saved = jsonDecode(store.get('wgo:q:wk_test')!) as List;
      expect(saved.single['a'], c.session.aid);
      expect(saved.single['e']['t'], 'custom');
    });
  });
}
