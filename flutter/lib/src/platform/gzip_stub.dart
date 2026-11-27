/// No gzip without dart:io (Flutter web): batches are sent uncompressed.
List<int> Function(List<int>)? get platformGzip => null;
