import 'package:flutter/material.dart';

/// 心得列表里的文件夹行：左「图标 + 名称」，右「笔记数 + ›」。
/// 有子文件夹时行首多一个展开箭头，和右侧的进入箭头区分开。
class ReflectionFolderRow extends StatelessWidget {
  const ReflectionFolderRow({
    super.key,
    required this.name,
    required this.noteCount,
    required this.onTap,
    this.onLongPress,
    this.depth = 0,
    this.expandable = false,
    this.expanded = false,
    this.onToggleExpand,
  });

  final String name;
  final int noteCount;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;
  final int depth;
  final bool expandable;
  final bool expanded;
  final VoidCallback? onToggleExpand;

  static const folderColor = Color(0xFFE2B23C);

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return ListTile(
      contentPadding: EdgeInsets.only(left: 8 + depth * 16, right: 8),
      leading: SizedBox(
        width: 56,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (!expandable)
              const SizedBox(width: 30)
            else
              SizedBox(
                width: 30,
                height: 30,
                child: InkResponse(
                  radius: 18,
                  onTap: onToggleExpand,
                  child: Icon(
                    expanded ? Icons.arrow_drop_down : Icons.arrow_right,
                    size: 20,
                    semanticLabel: expanded ? '折叠' : '展开',
                  ),
                ),
              ),
            const Icon(Icons.folder, color: folderColor, size: 22),
          ],
        ),
      ),
      title: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            '$noteCount',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: scheme.onSurfaceVariant,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
          const SizedBox(width: 2),
          Icon(Icons.chevron_right, size: 18, color: scheme.outlineVariant),
        ],
      ),
      onTap: onTap,
      onLongPress: onLongPress,
    );
  }
}

/// 心得列表里的笔记行：标题一行，下面小字「时间 + 正文摘要」，只占一行。
class ReflectionNoteRow extends StatelessWidget {
  const ReflectionNoteRow({
    super.key,
    required this.title,
    required this.preview,
    required this.onTap,
    this.onLongPress,
  });

  final String title;
  final String preview;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ListTile(
      visualDensity: VisualDensity.compact,
      title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text(
        preview,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: theme.textTheme.bodySmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
      onTap: onTap,
      onLongPress: onLongPress,
    );
  }
}
