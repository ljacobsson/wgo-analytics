// material_ui replaces it from Flutter 3.47; the example supports older Flutter, where it doesn't exist yet
// ignore: deprecated_member_use
import 'package:flutter/material.dart';
import 'package:wgo_flutter/wgo_flutter.dart';

/// Run with your project's write key and WGO endpoint:
///
///     flutter run --dart-define=WGO_WRITE_KEY=wk_… --dart-define=WGO_ENDPOINT=https://wgo.example.com
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Wgo.init(const WgoConfig(
    writeKey: String.fromEnvironment('WGO_WRITE_KEY'),
    endpoint: String.fromEnvironment('WGO_ENDPOINT'),
    release: '1.0.0+1',
    environment: 'dev',
    debug: true,
  ));
  runApp(const ExampleApp());
}

final api = WgoHttpClient();

class ExampleApp extends StatelessWidget {
  const ExampleApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'WGO example',
        navigatorObservers: [WgoNavigatorObserver()],
        routes: {
          '/': (_) => const HomePage(),
          '/settings': (_) => const SettingsPage(),
        },
      );
}

class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Home')),
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            WgoTrack(
              name: 'open_settings',
              label: 'Settings',
              child: FilledButton(
                onPressed: () => Navigator.pushNamed(context, '/settings'),
                child: const Text('Settings'),
              ),
            ),
            const SizedBox(height: 12),
            OutlinedButton(
              onPressed: () => Wgo.track('signup_clicked', {'plan': 'pro'}),
              child: const Text('Send a custom event'),
            ),
            OutlinedButton(
              onPressed: () => Wgo.identify('user_42', {'plan': 'pro'}),
              child: const Text('Log in as user_42'),
            ),
            OutlinedButton(onPressed: Wgo.reset, child: const Text('Log out')),
            OutlinedButton(
              onPressed: () => api.get(Uri.parse('https://httpbin.org/status/503')),
              child: const Text('Make a failing request'),
            ),
            OutlinedButton(
              onPressed: () => throw StateError('Thrown from a button'),
              child: const Text('Throw an error'),
            ),
          ],
        ),
      );
}

class SettingsPage extends StatelessWidget {
  const SettingsPage({super.key});

  @override
  Widget build(BuildContext context) =>
      Scaffold(appBar: AppBar(title: const Text('Settings')), body: const Center(child: Text('Settings')));
}
