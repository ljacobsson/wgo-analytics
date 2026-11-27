import 'dart:ui' show PlatformDispatcher, Size;

import 'package:flutter/foundation.dart';

import 'client.dart' show sdkName;

/// A user agent the WGO backend's parser reads as this platform, phone or tablet (backend/src/lib/ua.ts). None on
/// the web: the backend then uses the browser's own `User-Agent` header.
String? userAgent({required bool tablet}) {
  if (kIsWeb) return null;
  final device = switch (defaultTargetPlatform) {
    TargetPlatform.android => tablet ? 'Linux; Android' : 'Linux; Android; Mobile',
    TargetPlatform.iOS => tablet ? 'iPad; iOS' : 'iPhone; iOS',
    TargetPlatform.macOS => 'Macintosh; Mac OS X',
    TargetPlatform.windows => 'Windows',
    TargetPlatform.linux => 'X11; Linux',
    TargetPlatform.fuchsia => 'Fuchsia',
  };
  return '$sdkName ($device)';
}

/// Batch context from the device: user agent, language and screen size in logical pixels (the web's CSS pixels).
Map<String, Object?> deviceContext() {
  final ctx = <String, Object?>{};
  Size? size;
  try {
    final d = PlatformDispatcher.instance;
    ctx['lang'] = d.locale.toLanguageTag();
    final view = d.implicitView ?? (d.views.isEmpty ? null : d.views.first);
    if (view != null) {
      try {
        size = view.display.size / view.display.devicePixelRatio;
      } catch (_) {
        if (view.devicePixelRatio > 0) size = view.physicalSize / view.devicePixelRatio;
      }
    }
    if (size != null && !size.isEmpty && size.isFinite) {
      ctx['sw'] = size.width.round();
      ctx['sh'] = size.height.round();
    } else {
      size = null;
    }
  } catch (_) {/* partial context is fine */}
  // Material's breakpoint: a shortest side of 600 logical pixels or more is a tablet
  final ua = userAgent(tablet: size != null && size.shortestSide >= 600);
  if (ua != null) ctx['ua'] = ua;
  return ctx;
}
