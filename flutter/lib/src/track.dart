import 'package:flutter/gestures.dart' show kTouchSlop;
import 'package:flutter/widgets.dart';

import 'wgo.dart';

/// Names the taps on [child] (the web SDK's `data-track`): their `click` events get `name` and use it as their
/// selector, so the dashboard and live watches see `checkout` instead of `FilledButton "Pay"`.
///
/// ```dart
/// WgoTrack(name: 'checkout', child: FilledButton(onPressed: pay, child: const Text('Pay')))
/// ```
///
/// Taps on every tappable widget are reported anyway (`captureTaps`); `WgoTrack` also reports taps on widgets
/// that aren't tappable, and, with `captureTaps` off, is the only way taps are reported. It only listens: the
/// child's own gestures work as before.
class WgoTrack extends StatefulWidget {
  const WgoTrack({super.key, required this.name, required this.child, this.label, this.priority = false});

  /// The click target's name; the dashboard groups clicks by it.
  final String name;

  /// Visible text to show with the click (never put what a user typed here).
  final String? label;

  /// Send within a second (`priorityFlushDelay`), for realtime watches.
  final bool priority;
  final Widget child;

  @override
  State<WgoTrack> createState() => _WgoTrackState();
}

class _WgoTrackState extends State<WgoTrack> {
  int? _pointer;
  Offset _down = Offset.zero;

  void _up(PointerUpEvent e) {
    if (e.pointer != _pointer) return;
    _pointer = null;
    if (Wgo.capturingTaps) return; // reported, with this name, by the tap capture
    if ((e.position - _down).distance > kTouchSlop) return; // a drag or scroll, not a tap
    final size = MediaQuery.maybeSizeOf(context) ?? Size.zero;
    final w = widget;
    final tag = w.child.runtimeType.toString();
    Wgo.client?.tap(w.name,
        name: w.name,
        label: w.label,
        tag: tag,
        x: e.position.dx,
        y: e.position.dy,
        width: size.width,
        height: size.height,
        priority: w.priority);
  }

  @override
  Widget build(BuildContext context) => Listener(
        onPointerDown: (e) {
          if (_pointer != null) return;
          _pointer = e.pointer;
          _down = e.position;
        },
        onPointerUp: _up,
        onPointerCancel: (e) {
          if (e.pointer == _pointer) _pointer = null;
        },
        child: widget.child,
      );
}

/// Taps on [child] and everything in it are never reported (the web SDK's `data-wgo-ignore`).
class WgoIgnore extends StatelessWidget {
  const WgoIgnore({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => child;
}

/// Taps on [child] are reported without the text they show (the web SDK's `data-wgo-mask`): for names, amounts or
/// anything else personal on a tappable widget.
class WgoMask extends StatelessWidget {
  const WgoMask({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => child;
}
