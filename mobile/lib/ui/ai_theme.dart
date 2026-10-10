import 'package:flutter/material.dart';

import '../src/app_controller.dart';

ThemeData aiTheme(AppController controller) {
  final scheme = switch (controller.themeId) {
    'daylight' => const ColorScheme(
        brightness: Brightness.light,
        primary: Color(0xFF2457E6),
        onPrimary: Colors.white,
        secondary: Color(0xFF4F9A69),
        onSecondary: Colors.white,
        error: Color(0xFFD15252),
        onError: Colors.white,
        surface: Color(0xFFF7F8FA),
        onSurface: Color(0xFF1F2937),
      ),
    'monochrome' => const ColorScheme(
        brightness: Brightness.dark,
        primary: Color(0xFFE6E6E6),
        onPrimary: Color(0xFF202020),
        secondary: Color(0xFFA7C39C),
        onSecondary: Color(0xFF202020),
        error: Color(0xFFE08A8A),
        onError: Color(0xFF202020),
        surface: Color(0xFF202020),
        onSurface: Color(0xFFF2F2F2),
      ),
    _ => const ColorScheme(
        brightness: Brightness.light,
        primary: Color(0xFFD9772B),
        onPrimary: Colors.white,
        secondary: Color(0xFF4C9B72),
        onSecondary: Colors.white,
        error: Color(0xFFAD5E58),
        onError: Colors.white,
        surface: Color(0xFFEEE8D5),
        onSurface: Color(0xFF414750),
      ),
  };
  final family = controller.serif ? 'Georgia' : null;
  final factor = controller.fontSize / 16;
  final base = ThemeData(colorScheme: scheme, useMaterial3: true, fontFamily: family);
  return base.copyWith(
    textTheme: base.textTheme.apply(fontSizeFactor: factor, bodyColor: scheme.onSurface),
    scaffoldBackgroundColor: scheme.surface,
  );
}

bool isTablet(BuildContext context) => MediaQuery.sizeOf(context).shortestSide >= 600;

bool isWideTablet(BuildContext context) => isTablet(context) && MediaQuery.sizeOf(context).width >= 1000;
