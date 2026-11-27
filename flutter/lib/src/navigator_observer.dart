import 'package:flutter/widgets.dart';

import 'wgo.dart';

/// Reports a screen view whenever a page route becomes the top of the navigator: pushed, replaced, or uncovered by a
/// pop. Dialogs, bottom sheets and menus are not screens and are ignored.
///
/// Routes are named by [RouteSettings.name] (`Navigator.pushNamed`, `MaterialApp.routes`, most routers). Unnamed
/// routes are skipped unless [nameOf] names them.
class WgoNavigatorObserver extends NavigatorObserver {
  WgoNavigatorObserver({this.nameOf});

  /// The screen name of a route, or null to skip it. Defaults to `route.settings.name`.
  final String? Function(Route<dynamic> route)? nameOf;

  void _view(Route<dynamic>? route) {
    if (route is! PageRoute) return;
    String? name;
    try {
      name = nameOf != null ? nameOf!(route) : route.settings.name;
    } catch (_) {
      return;
    }
    if (name == null || name.isEmpty) return;
    Wgo.screen(name);
  }

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) => _view(route);

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) => _view(newRoute);

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    // closing a dialog uncovers the same screen: not a new view
    if (route is PageRoute) _view(previousRoute);
  }
}
