import 'package:flutter/gestures.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

import 'client.dart';
import 'track.dart';

/// Controls a tap is reported on, by widget type name, Material and Cupertino included (this package depends on
/// the widgets library only). The innermost one around the tap recognizer names the control; the [_containers]
/// only when there is none.
const _controls = {
  'ElevatedButton', 'FilledButton', 'TextButton', 'OutlinedButton', 'IconButton', 'FloatingActionButton',
  'BackButton', 'CloseButton', 'DrawerButton', 'EndDrawerButton', 'ListTile', 'CheckboxListTile',
  'SwitchListTile', 'RadioListTile', 'ExpansionTile', 'Checkbox', 'Switch', 'Radio', 'Chip', 'ActionChip',
  'ChoiceChip', 'FilterChip', 'InputChip', 'RawChip', 'PopupMenuButton', 'PopupMenuItem', 'CheckedPopupMenuItem',
  'DropdownButton', 'DropdownButtonFormField', 'DropdownMenu', 'DropdownMenuItem', 'MenuItemButton',
  'SubmenuButton', 'SegmentedButton', 'Tab', 'NavigationDestination', 'NavigationDrawerDestination',
  'NavigationRailDestination', 'BottomNavigationBar', 'TextField', 'TextFormField', 'SearchBar', 'Card',
  'CupertinoButton', 'CupertinoListTile', 'CupertinoSwitch', 'CupertinoCheckbox',
  'CupertinoRadio', 'CupertinoTextField', 'CupertinoSegmentedControl', 'CupertinoSlidingSegmentedControl',
  'CupertinoContextMenuAction', 'CupertinoActionSheetAction', 'CupertinoDialogAction',
};

/// Generic tappable areas: named after the outermost one when no control is around the recognizer.
const _containers = {'InkWell', 'InkResponse', 'Card'};

/// How far above its tap recognizer a control may be (in elements), and how much bigger (logical pixels): a
/// button's padding and minimum tap target, not the column it sits in.
const _maxDepth = 60;
const _maxGrowth = 24.0;
const _labelMax = 80;

/// A tap, described like a click on the web.
typedef TapTarget = ({String sel, String tag, String? text, String? name, bool priority});

/// Reports taps on any tappable widget, with no changes to the app: it listens to every pointer event (a global
/// pointer route) and, for a tap, finds the control under it in the widget tree.
class TapCapture {
  TapCapture(this.client);
  final WgoClient client;

  int? _pointer;
  Offset _down = Offset.zero;

  void start() => GestureBinding.instance.pointerRouter.addGlobalRoute(_route);
  void stop() => GestureBinding.instance.pointerRouter.removeGlobalRoute(_route);

  void _route(PointerEvent e) {
    try {
      if (e is PointerDownEvent) {
        // a second finger makes it a gesture, not a tap; mouse taps are primary-button clicks
        _pointer = _pointer == null && (e.kind != PointerDeviceKind.mouse || e.buttons == kPrimaryButton) ? e.pointer : null;
        _down = e.position;
        return;
      }
      if (e.pointer != _pointer) return;
      if (e is PointerMoveEvent) {
        if ((e.position - _down).distance > kTouchSlop) _pointer = null; // a drag or scroll
      } else if (e is PointerUpEvent) {
        _pointer = null;
        // tap callbacks run after this (when the gesture arena is swept), so the tree is still as it was tapped
        _tap(e.position, e.viewId);
      } else if (e is PointerCancelEvent) {
        _pointer = null;
      }
    } catch (err) {
      client.log('tap capture failed', err);
    }
  }

  void _tap(Offset position, int viewId) {
    final chain = elementsAt(position, viewId);
    if (chain == null) return;
    final t = describeTap(chain);
    if (t == null) return;
    final view = WidgetsBinding.instance.platformDispatcher.view(id: viewId);
    final size = view == null || view.devicePixelRatio <= 0 ? Size.zero : view.physicalSize / view.devicePixelRatio;
    client.tap(t.sel,
        name: t.name,
        label: t.text,
        tag: t.tag,
        x: position.dx,
        y: position.dy,
        width: size.width,
        height: size.height,
        priority: t.priority);
  }
}

/// The elements from the root down to the one whose render object is hit at [position], or null.
List<Element>? elementsAt(Offset position, int viewId) {
  final result = HitTestResult();
  GestureBinding.instance.hitTestInView(result, position, viewId);
  RenderObject? leaf;
  for (final entry in result.path) {
    final t = entry.target;
    if (t is RenderObject) {
      leaf = t;
      break;
    }
  }
  final root = WidgetsBinding.instance.rootElement;
  if (leaf == null || root == null) return null;
  final ancestors = <RenderObject>{};
  for (RenderObject? r = leaf; r != null; r = r.parent) {
    ancestors.add(r);
  }
  // follow the render tree's path down the element tree: one child per level holds the next render object
  final chain = <Element>[root];
  for (var i = 0; i < 20000; i++) {
    Element? next;
    chain.last.visitChildElements((c) {
      if (next == null && ancestors.contains(c.renderObject)) next = c;
    });
    if (next == null) break;
    chain.add(next!);
  }
  return chain.last.renderObject == leaf ? chain : null;
}

/// The control a tap on the innermost element of [chain] is reported on, or null when nothing tappable is there.
TapTarget? describeTap(List<Element> chain) {
  var masked = false;
  for (final e in chain) {
    if (e.widget is WgoIgnore) return null;
    if (e.widget is WgoMask) masked = true;
  }
  // the innermost tap recognizer (or WgoTrack) around the tapped point
  var anchor = -1;
  for (var i = chain.length - 1; i >= 0; i--) {
    final w = chain[i].widget;
    if (w is WgoTrack || _tappable(w)) {
      anchor = i;
      break;
    }
  }
  if (anchor < 0) return null;
  WgoTrack? track;
  for (var i = anchor; i >= 0; i--) {
    final w = chain[i].widget;
    if (w is WgoTrack) {
      track = w;
      break;
    }
  }

  var control = anchor;
  String? tag;
  final anchorWidget = chain[anchor].widget;
  if (anchorWidget is WgoTrack) {
    tag = _name(anchorWidget.child); // nothing tappable inside: the WgoTrack and its child are the control
  } else {
    final base = _size(chain[anchor]);
    for (var i = anchor - 1; i >= 0 && anchor - i <= _maxDepth; i--) {
      final w = chain[i].widget;
      if (w is WgoTrack || _tappable(w)) break;
      final s = _size(chain[i]);
      if (base != null && s != null && (s.width > base.width + _maxGrowth || s.height > base.height + _maxGrowth)) break;
      final n = _name(w);
      if (_controls.contains(n)) {
        control = i;
        tag = n;
        break;
      }
      if (_containers.contains(n)) {
        control = i;
        tag = n;
      }
    }
    tag ??= anchor > 0 && _name(chain[anchor - 1].widget) == 'GestureDetector' ? 'GestureDetector' : _name(chain[anchor].widget);
  }

  String? key;
  for (var i = control; i <= anchor && key == null; i++) {
    key = _keyOf(chain[i].widget);
  }
  final label = masked ? null : labelOf(chain[control]);
  final String sel;
  if (track != null) {
    sel = track.name;
  } else if (key != null) {
    sel = '$tag#$key';
  } else if (label != null && label.text != null) {
    sel = '$tag "${label.text}"';
  } else if (label != null && label.icon != null) {
    sel = '$tag icon:${label.icon}';
  } else {
    sel = tag;
  }
  return (sel: sel, tag: tag, text: track?.label ?? label?.text, name: track?.name, priority: track?.priority ?? false);
}

bool _tappable(Widget w) =>
    w is RawGestureDetector &&
    w.gestures.keys.any((t) => t == TapGestureRecognizer || t == TapAndPanGestureRecognizer || t == DoubleTapGestureRecognizer);

/// `DropdownButton<String>` → `DropdownButton`, `_ElevatedButtonWithIcon` → `ElevatedButton`.
String _name(Widget w) {
  var n = w.runtimeType.toString();
  final lt = n.indexOf('<');
  if (lt > 0) n = n.substring(0, lt);
  if (n.startsWith('_')) n = n.substring(1);
  if (n.endsWith('WithIcon')) n = n.substring(0, n.length - 'WithIcon'.length);
  return n;
}

String? _keyOf(Widget w) {
  final k = w.key;
  if (k is! ValueKey) return null;
  final v = k.value;
  if (v is String && v.isNotEmpty) return v;
  if (v is num || v is Enum) return '$v';
  return null;
}

Size? _size(Element e) {
  final ro = e.renderObject;
  return ro is RenderBox && ro.hasSize ? ro.size : null;
}

/// Whitespace collapsed; icon-font glyphs (Unicode private use areas) removed.
String _clean(String s) =>
    s.replaceAll(RegExp(r'[\uE000-\uF8FF]|[\u{F0000}-\u{10FFFF}]', unicode: true), '').replaceAll(RegExp(r'\s+'), ' ').trim();

/// A control's visible wording, the way screen readers find it: an explicit semantics label, else its text, else
/// its tooltip or icon label. Never what was typed into a field (`EditableText` is skipped). [icon] is the code
/// point of its first icon, for icon-only controls.
({String? text, String? icon})? labelOf(Element control) {
  String? semantics, tooltip, iconLabel, icon;
  final texts = <String>[];
  var budget = 400;
  void visit(Element e) {
    if (--budget < 0 || texts.length >= 3) return;
    final w = e.widget;
    if (w is EditableText || w is WgoMask) return;
    if (w is Text) {
      final t = _clean(w.data ?? w.textSpan?.toPlainText() ?? '');
      if (t.isNotEmpty) texts.add(t);
      return;
    }
    if (w is RichText) {
      final t = _clean(w.text.toPlainText());
      if (t.isNotEmpty) texts.add(t);
      return;
    }
    if (w is Icon) {
      icon ??= w.icon?.codePoint.toRadixString(16);
      final l = _clean(w.semanticLabel ?? '');
      if (l.isNotEmpty) iconLabel ??= l;
      return; // its glyph is drawn as text
    }
    if (w is Semantics) {
      final l = _clean(w.properties.label ?? '');
      if (l.isNotEmpty) semantics ??= l;
      final t = _clean(w.properties.tooltip ?? '');
      if (t.isNotEmpty) tooltip ??= t;
    }
    e.visitChildElements(visit);
  }

  visit(control);
  var text = semantics ?? (texts.isEmpty ? null : texts.join(' ')) ?? tooltip ?? iconLabel;
  if (text != null && text.length > _labelMax) text = '${text.substring(0, _labelMax - 1).trimRight()}…';
  return text == null && icon == null ? null : (text: text, icon: icon);
}
