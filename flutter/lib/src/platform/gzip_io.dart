import 'dart:io' show gzip;

List<int> Function(List<int>)? get platformGzip => gzip.encode;
