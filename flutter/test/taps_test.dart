// material_ui and cupertino_ui replace these from Flutter 3.47; the SDK supports older Flutter, where they don't
// exist yet
// ignore_for_file: deprecated_member_use
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wgo_flutter/wgo_flutter.dart';

import 'helpers.dart';

/// Pumps [body] in an app with the SDK running, runs [interact], and returns the click events' `d`.
Future<List<Map<String, dynamic>>> clicks(WidgetTester tester, Widget body, Future<void> Function() interact,
    {bool captureTaps = true}) async {
  final ingest = FakeIngest();
  await tester.runAsync(() => Wgo.init(
        WgoConfig(writeKey: 'wk_test', endpoint: endpoint, captureTaps: captureTaps, captureErrors: false),
        storage: MemoryStorage(),
        httpClient: ingest.client,
      ));
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: Center(child: body))));
  await interact();
  await tester.pump();
  await tester.runAsync(() async {
    await Wgo.flush();
    await Wgo.shutdown();
  });
  return [for (final e in ingest.ofType('click')) (e['d'] as Map).cast<String, dynamic>()];
}

void main() {
  testWidgets('a button is reported with its type and text, and still works', (tester) async {
    var pressed = 0;
    final d = await clicks(
      tester,
      ElevatedButton(onPressed: () => pressed++, child: const Text('Pay  now')),
      () => tester.tap(find.text('Pay  now')),
    );
    expect(pressed, 1);
    expect(d.single, containsPair('sel', 'ElevatedButton "Pay now"'));
    expect(d.single, containsPair('tag', 'ElevatedButton'));
    expect(d.single, containsPair('text', 'Pay now'));
    expect(d.single.containsKey('name'), isFalse);
    expect(d.single['vw'], 800);
    expect(d.single['x'], 400);
  });

  testWidgets('buttons with icons are named by their public type', (tester) async {
    final d = await clicks(
      tester,
      FilledButton.icon(onPressed: () {}, icon: const Icon(Icons.add), label: const Text('Add')),
      () => tester.tap(find.text('Add')),
    );
    expect(d.single['sel'], 'FilledButton "Add"');
  });

  testWidgets('icon buttons use their tooltip, or the icon', (tester) async {
    final d = await clicks(
      tester,
      Row(mainAxisSize: MainAxisSize.min, children: [
        IconButton(onPressed: () {}, tooltip: 'Delete', icon: const Icon(Icons.delete)),
        IconButton(onPressed: () {}, icon: const Icon(Icons.share)),
      ]),
      () async {
        await tester.tap(find.byIcon(Icons.delete));
        await tester.pump(const Duration(seconds: 2));
        await tester.tap(find.byIcon(Icons.share));
        await tester.pump(const Duration(seconds: 2));
      },
    );
    expect(d.map((x) => x['sel']), ['IconButton "Delete"', 'IconButton icon:${Icons.share.codePoint.toRadixString(16)}']);
    expect(d[1].containsKey('text'), isFalse);
  });

  testWidgets('a ValueKey identifies the control', (tester) async {
    final d = await clicks(
      tester,
      OutlinedButton(key: const ValueKey('buy'), onPressed: () {}, child: const Text('Buy')),
      () => tester.tap(find.text('Buy')),
    );
    expect(d.single['sel'], 'OutlinedButton#buy');
    expect(d.single['text'], 'Buy');
  });

  testWidgets('list tiles in a scrolling list; scrolling is not a tap', (tester) async {
    final d = await clicks(
      tester,
      ListView(children: [
        for (var i = 0; i < 30; i++) ListTile(title: Text('Item $i'), subtitle: const Text('Details'), onTap: () {}),
      ]),
      () async {
        await tester.tap(find.text('Item 2'));
        await tester.drag(find.text('Item 3'), const Offset(0, -200));
        await tester.pumpAndSettle();
      },
    );
    expect(d.single['sel'], 'ListTile "Item 2 Details"');
  });

  testWidgets('text fields report their label, never what was typed', (tester) async {
    final d = await clicks(
      tester,
      const SizedBox(width: 300, child: TextField(decoration: InputDecoration(labelText: 'Email'))),
      () async {
        await tester.enterText(find.byType(TextField), 'secret@example.com');
        await tester.tap(find.byType(TextField));
      },
    );
    expect(d, isNotEmpty);
    expect(d.last['tag'], 'TextField');
    expect(d.last['text'], 'Email');
    expect(d.toString(), isNot(contains('secret')));
  });

  testWidgets('the innermost control names the tap; a card only when nothing else does', (tester) async {
    final d = await clicks(
      tester,
      Column(mainAxisSize: MainAxisSize.min, children: [
        Card(child: ListTile(title: const Text('In a card'), onTap: () {})),
        Card(child: InkWell(onTap: () {}, child: const Padding(padding: EdgeInsets.all(16), child: Text('Tappable card')))),
      ]),
      () async {
        await tester.tap(find.text('In a card'));
        await tester.tap(find.text('Tappable card'));
      },
    );
    expect(d.map((x) => x['sel']), ['ListTile "In a card"', 'Card "Tappable card"']);
  });

  testWidgets('a GestureDetector on your own widget', (tester) async {
    final d = await clicks(
      tester,
      GestureDetector(onTap: () {}, child: Container(padding: const EdgeInsets.all(20), child: const Text('Red shoes'))),
      () => tester.tap(find.text('Red shoes')),
    );
    expect(d.single['sel'], 'GestureDetector "Red shoes"');
  });

  testWidgets('Cupertino buttons', (tester) async {
    final d = await clicks(
      tester,
      CupertinoButton(onPressed: () {}, child: const Text('Continue')),
      () => tester.tap(find.text('Continue')),
    );
    expect(d.single['sel'], 'CupertinoButton "Continue"');
  });

  testWidgets('taps on text, disabled buttons and empty space are not reported', (tester) async {
    final d = await clicks(
      tester,
      const Column(mainAxisSize: MainAxisSize.min, children: [
        Text('Just text'),
        ElevatedButton(onPressed: null, child: Text('Disabled')),
      ]),
      () async {
        await tester.tap(find.text('Just text'));
        await tester.tap(find.text('Disabled'), warnIfMissed: false);
        await tester.tapAt(const Offset(5, 5));
      },
    );
    expect(d, isEmpty);
  });

  testWidgets('WgoIgnore drops taps; WgoMask drops their text', (tester) async {
    final d = await clicks(
      tester,
      Column(mainAxisSize: MainAxisSize.min, children: [
        WgoIgnore(child: TextButton(onPressed: () {}, child: const Text('Ignored'))),
        WgoMask(child: TextButton(onPressed: () {}, child: const Text('Jane Doe'))),
      ]),
      () async {
        await tester.tap(find.text('Ignored'));
        await tester.tap(find.text('Jane Doe'));
      },
    );
    expect(d.single['sel'], 'TextButton');
    expect(d.single.containsKey('text'), isFalse);
  });

  testWidgets('WgoTrack names a control once, and makes anything tappable', (tester) async {
    final d = await clicks(
      tester,
      Column(mainAxisSize: MainAxisSize.min, children: [
        WgoTrack(name: 'checkout', priority: true, child: FilledButton(onPressed: () {}, child: const Text('Pay'))),
        WgoTrack(name: 'banner', child: Container(width: 200, height: 50, color: const Color(0xff00ff00))),
      ]),
      () async {
        await tester.tap(find.text('Pay'));
        await tester.pump(const Duration(seconds: 2));
        await tester.tap(find.byType(Container).last);
      },
    );
    expect(d, hasLength(2));
    expect(d[0], containsPair('sel', 'checkout'));
    expect(d[0], containsPair('name', 'checkout'));
    expect(d[0], containsPair('tag', 'FilledButton'));
    expect(d[0], containsPair('text', 'Pay'));
    expect(d[1], containsPair('sel', 'banner'));
    expect(d[1], containsPair('tag', 'Container'));
  });

  testWidgets('with captureTaps off only WgoTrack reports taps', (tester) async {
    final d = await clicks(
      tester,
      Column(mainAxisSize: MainAxisSize.min, children: [
        TextButton(onPressed: () {}, child: const Text('Plain')),
        WgoTrack(name: 'named', child: TextButton(onPressed: () {}, child: const Text('Named'))),
      ]),
      () async {
        await tester.tap(find.text('Plain'));
        await tester.tap(find.text('Named'));
      },
      captureTaps: false,
    );
    expect(d.map((x) => x['sel']), ['named']);
  });
}
