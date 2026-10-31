import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:image/image.dart' as img;

/// 上传前裁剪 + 限长边 + 重编码，避免原图（几 MB）直接落盘和传输。
const kClientImageMaxEdge = 2048;
const kClientImageQuality = 88;

class CroppedImage {
  CroppedImage(this.bytes, this.mime, this.width, this.height);

  final Uint8List bytes;
  final String mime;
  final int width;
  final int height;
}

class _CropRequest {
  _CropRequest(this.bytes, this.left, this.top, this.width, this.height);

  final Uint8List bytes;
  final int left;
  final int top;
  final int width;
  final int height;
}

class _EncodedCrop {
  _EncodedCrop(this.bytes, this.alpha, this.width, this.height);

  final Uint8List bytes;
  final bool alpha;
  final int width;
  final int height;
}

_EncodedCrop _cropAndEncode(_CropRequest request) {
  final decoded = img.decodeImage(request.bytes);
  if (decoded == null) throw StateError('无法识别图片');
  final source = img.bakeOrientation(decoded);
  final left = request.left.clamp(0, math.max(0, source.width - 1)).toInt();
  final top = request.top.clamp(0, math.max(0, source.height - 1)).toInt();
  final width = request.width.clamp(1, source.width - left).toInt();
  final height = request.height.clamp(1, source.height - top).toInt();
  var cropped = img.copyCrop(
    source,
    x: left,
    y: top,
    width: width,
    height: height,
  );
  final longest = math.max(cropped.width, cropped.height);
  if (longest > kClientImageMaxEdge) {
    final scale = kClientImageMaxEdge / longest;
    cropped = img.copyResize(
      cropped,
      width: math.max(1, (cropped.width * scale).round()),
      height: math.max(1, (cropped.height * scale).round()),
      interpolation: img.Interpolation.average,
    );
  }
  final alpha = cropped.numChannels == 4;
  final encoded = alpha
      ? img.encodePng(cropped, level: 6)
      : img.encodeJpg(cropped, quality: kClientImageQuality);
  return _EncodedCrop(
    Uint8List.fromList(encoded),
    alpha,
    cropped.width,
    cropped.height,
  );
}

/// 全屏裁剪页：拖动选区移动，四角缩放。
/// 「不裁剪」返回传入的原始字节，「取消」返回 null。
class ImageCropPage extends StatefulWidget {
  const ImageCropPage({super.key, required this.bytes, this.mime = 'image/jpeg'});

  final Uint8List bytes;
  final String mime;

  @override
  State<ImageCropPage> createState() => _ImageCropPageState();
}

class _ImageCropPageState extends State<ImageCropPage> {
  img.Image? _decoded;
  String? _error;
  var _busy = false;

  Rect _rect = Rect.zero;
  Size _displaySize = Size.zero;
  var _geometryReady = false;

  Offset _dragStart = Offset.zero;
  Rect _dragRect = Rect.zero;
  _Corner? _activeCorner;

  static const _minSide = 48.0;
  static const _handleTouch = 44.0;

  @override
  void initState() {
    super.initState();
    _decode();
  }

  Future<void> _decode() async {
    try {
      final decoded = await compute(img.decodeImage, widget.bytes);
      if (!mounted) return;
      if (decoded == null) {
        setState(() => _error = '无法识别图片');
        return;
      }
      setState(() => _decoded = decoded);
    } catch (_) {
      if (mounted) setState(() => _error = '图片读取失败');
    }
  }

  void _syncGeometry(Size display) {
    if (_geometryReady && _displaySize == display) return;
    _displaySize = display;
    if (!_geometryReady) {
      _geometryReady = true;
      final w = display.width * 0.88;
      final h = display.height * 0.88;
      _rect = Rect.fromLTWH(
        (display.width - w) / 2,
        (display.height - h) / 2,
        w,
        h,
      );
      return;
    }
    // 窗口尺寸变了：按比例收缩到新范围里
    final scaleX = display.width / (_rect.right > 0 ? _rect.right : display.width);
    final scaleY = display.height / (_rect.bottom > 0 ? _rect.bottom : display.height);
    final scale = math.min(1.0, math.min(scaleX, scaleY));
    _rect = Rect.fromLTWH(
      _rect.left * scale,
      _rect.top * scale,
      math.max(_minSide, _rect.width * scale),
      math.max(_minSide, _rect.height * scale),
    );
  }

  void _onMoveStart(DragStartDetails details) {
    _activeCorner = null;
    _dragStart = details.localPosition;
    _dragRect = _rect;
  }

  void _onCornerStart(DragStartDetails details, _Corner corner) {
    _activeCorner = corner;
    _dragStart = details.localPosition;
    _dragRect = _rect;
  }

  void _onDragUpdate(DragUpdateDetails details) {
    final delta = details.localPosition - _dragStart;
    final base = _dragRect;
    const min = _minSide;
    final maxW = _displaySize.width;
    final maxH = _displaySize.height;
    final corner = _activeCorner;
    if (corner == null) {
      final left = (base.left + delta.dx)
          .clamp(0.0, math.max(0.0, maxW - base.width))
          .toDouble();
      final top = (base.top + delta.dy)
          .clamp(0.0, math.max(0.0, maxH - base.height))
          .toDouble();
      setState(() {
        _rect = Rect.fromLTWH(left, top, base.width, base.height);
      });
      return;
    }
    var left = base.left;
    var top = base.top;
    var right = base.right;
    var bottom = base.bottom;
    if (corner.onLeft) {
      left = (base.left + delta.dx).clamp(0.0, right - min).toDouble();
    } else {
      right = (base.right + delta.dx).clamp(left + min, maxW).toDouble();
    }
    if (corner.onTop) {
      top = (base.top + delta.dy).clamp(0.0, bottom - min).toDouble();
    } else {
      bottom = (base.bottom + delta.dy).clamp(top + min, maxH).toDouble();
    }
    setState(() {
      _rect = Rect.fromLTRB(left, top, right, bottom);
    });
  }

  void _skip() {
    final decoded = _decoded;
    Navigator.of(context).pop(
      CroppedImage(
        widget.bytes,
        widget.mime,
        decoded?.width ?? 0,
        decoded?.height ?? 0,
      ),
    );
  }

  Future<void> _confirm() async {    final decoded = _decoded;
    if (decoded == null || _busy || _displaySize.isEmpty) return;
    setState(() => _busy = true);
    final scale = decoded.width / _displaySize.width;
    final left = (_rect.left * scale).round().clamp(0, decoded.width - 1);
    final top = (_rect.top * scale).round().clamp(0, decoded.height - 1);
    final width = (_rect.width * scale).round().clamp(1, decoded.width - left);
    final height = (_rect.height * scale).round().clamp(1, decoded.height - top);
    try {
      final encoded = await compute(
        _cropAndEncode,
        _CropRequest(widget.bytes, left, top, width, height),
      );
      if (!mounted) return;
      Navigator.of(context).pop(
        CroppedImage(
          encoded.bytes,
          encoded.alpha ? 'image/png' : 'image/jpeg',
          encoded.width,
          encoded.height,
        ),
      );
    } catch (_) {
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('裁剪失败')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final decoded = _decoded;
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: const Text('裁剪图片'),
        actions: [
          TextButton(
            onPressed: _busy ? null : () => Navigator.of(context).pop(),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: _busy ? null : _confirm,
            child: Text(_busy ? '处理中…' : '完成'),
          ),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: _error != null
                ? Center(child: Text(_error!, style: TextStyle(color: scheme.error)))
                : decoded == null
                    ? const Center(child: CircularProgressIndicator())
                    : LayoutBuilder(
                        builder: (context, constraints) {
                          final available = Size(
                            constraints.maxWidth - 32,
                            constraints.maxHeight - 32,
                          );
                          final scale = math.min(
                            available.width / decoded.width,
                            available.height / decoded.height,
                          );
                          final size = Size(
                            decoded.width * scale,
                            decoded.height * scale,
                          );
                          _syncGeometry(size);
                          return Center(
                            child: SizedBox(
                              width: size.width,
                              height: size.height,
                              child: Stack(
                                children: [
                                  Positioned.fill(
                                    child: Image.memory(
                                      widget.bytes,
                                      fit: BoxFit.fill,
                                      gaplessPlayback: true,
                                    ),
                                  ),
                                  Positioned.fill(
                                    child: IgnorePointer(
                                      child: CustomPaint(
                                        painter: _CropPainter(_rect, size),
                                      ),
                                    ),
                                  ),
                                  Positioned.fromRect(
                                    rect: _rect,
                                    child: GestureDetector(
                                      behavior: HitTestBehavior.opaque,
                                      onPanStart: _onMoveStart,
                                      onPanUpdate: _onDragUpdate,
                                    ),
                                  ),
                                  for (final corner in _Corner.values) _handle(corner),
                                ],
                              ),
                            ),
                          );
                        },
                      ),
          ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      '拖动选区移动，四角缩放。原图会压缩后再上传。',
                      style: Theme.of(context)
                          .textTheme
                          .bodySmall
                          ?.copyWith(color: Colors.white70),
                    ),
                  ),
                  TextButton(
                    onPressed: _busy ? null : _skip,
                    child: const Text('不裁剪'),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _handle(_Corner corner) {
    final position = Offset(
      corner.onLeft ? _rect.left : _rect.right,
      corner.onTop ? _rect.top : _rect.bottom,
    );
    return Positioned(
      left: position.dx - _handleTouch / 2,
      top: position.dy - _handleTouch / 2,
      width: _handleTouch,
      height: _handleTouch,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onPanStart: (details) => _onCornerStart(details, corner),
        onPanUpdate: _onDragUpdate,
        child: Center(
          child: Container(
            width: 18,
            height: 18,
            decoration: BoxDecoration(
              color: Colors.white,
              shape: BoxShape.circle,
              border: Border.all(color: Colors.black26),
            ),
          ),
        ),
      ),
    );
  }
}

enum _Corner {
  topLeft(onLeft: true, onTop: true),
  topRight(onLeft: false, onTop: true),
  bottomLeft(onLeft: true, onTop: false),
  bottomRight(onLeft: false, onTop: false);

  const _Corner({required this.onLeft, required this.onTop});

  final bool onLeft;
  final bool onTop;
}

class _CropPainter extends CustomPainter {
  _CropPainter(this.rect, this.overlaySize);

  final Rect rect;
  final Size overlaySize;

  @override
  void paint(Canvas canvas, Size size) {
    final cut = Path()
      ..addRect(Offset.zero & overlaySize)
      ..addRect(rect)
      ..fillType = PathFillType.evenOdd;
    canvas.drawPath(cut, Paint()..color = Colors.black54);
    canvas.drawRect(
      rect,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2
        ..color = Colors.white,
    );
    final grid = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..color = Colors.white38;
    for (var i = 1; i < 3; i += 1) {
      final x = rect.left + rect.width * i / 3;
      final y = rect.top + rect.height * i / 3;
      canvas.drawLine(Offset(x, rect.top), Offset(x, rect.bottom), grid);
      canvas.drawLine(Offset(rect.left, y), Offset(rect.right, y), grid);
    }
  }

  @override
  bool shouldRepaint(_CropPainter oldDelegate) =>
      oldDelegate.rect != rect || oldDelegate.overlaySize != overlaySize;
}
