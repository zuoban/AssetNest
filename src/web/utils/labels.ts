import type { JobType, ValidationIssue } from "../../shared/types";

export const ACTIVITY_ACTION_LABELS: Record<string, string> = {
  "setup.init": "初始化系统",
  "auth.login": "访问码登录",
  "auth.login_failed": "访问码验证失败",
  "auth.logout": "退出登录",
  "auth.admin_reset_cli": "宿主机重置管理员密码",
  "auth.admin_created_cli": "宿主机创建管理员账号",
  "settings.update": "更新系统设置",
  "cache.clear": "清理本地缩略图缓存",
  "product.create": "新建商品档案",
  "product.update": "更新商品信息",
  "product.soft_delete": "商品移入回收站",
  "product.master_image.lock": "锁定商品母图",
  "product.master_image.set_primary": "设为主参考母图",
  "product.master_image.unlock": "解锁商品母图",
  "sku.create": "新建 SKU 变体",
  "sku.update": "更新 SKU 变体",
  "sku.delete": "删除 SKU 变体",
  "folder.create": "新建素材文件夹",
  "folder.update": "更新文件夹",
  "folder.delete": "删除文件夹",
  "tag.create": "新建标签",
  "tag.update": "更新标签",
  "tag.delete": "删除标签",
  "asset.upload": "上传素材",
  "asset.update": "更新素材属性",
  "asset.version.append": "上传素材新版本",
  "asset.current_version.switch": "切换当前素材版本",
  "asset.batch.move_folder": "批量移动素材文件夹",
  "asset.batch.add_tags": "批量添加素材标签",
  "asset.batch.remove_tags": "批量移除素材标签",
  "asset.batch.link_products": "批量关联商品",
  "asset.batch.unlink_products": "批量取消商品关联",
  "asset.batch.soft_delete": "批量移入回收站",
  "asset.export_standard": "导出开放标准素材包",
  "dictionary.upsert": "新增渠道字典项",
  "dictionary.update": "更新渠道字典项",
  "store.create": "新建店铺",
  "store.update": "更新店铺配置",
  "store.delete": "删除店铺",
  "listing.create": "新建上架链接",
  "listing.update": "更新上架链接",
  "listing.soft_delete": "上架链接移入回收站",
  "listing.duplicate": "复制为独立草稿链接",
  "listing.skus.sync": "同步上架链接 SKU",
  "listing.asset_set.update": "编排上架素材组",
  "listing.pdp.draft_save": "保存 PDP 文案草稿",
  "listing.pdp.version_create": "冻结 PDP 文案版本",
  "listing.pdp.restore_draft": "从历史版本恢复 PDP 草稿",
  "listing.pdp.copy_to": "复制 PDP 文案至其他链接",
  "export_template.create": "新建导出模板规则",
  "export_template.update": "更新导出模板规则",
  "release.create": "创建正式上架快照 (Release)",
  "release.export_zip_enqueue": "生成上架导出 ZIP 包",
  "release.restore_draft": "从历史快照恢复新草稿",
  "storage.test": "检测存储空间连通性",
  "storage.default.switch": "切换默认写入存储",
  "storage.delete": "移除存储空间配置",
  "storage.migrate.start": "发起跨存储安全迁移",
  "storage.cleanup.confirm": "确认清理旧存储对象",
  "trash.restore": "从回收站恢复项目",
  "trash.gc.start": "执行引用保护垃圾回收",
  "backup.create": "创建一致性系统备份",
  "backup.restore": "执行维护模式备份恢复",
  "job.retry": "重试后台任务",
  "job.cancel": "取消后台任务"
};

export const OBJECT_TYPE_LABELS: Record<string, string> = {
  session: "会话",
  user: "用户",
  settings: "系统设置",
  cache: "缓存",
  product: "商品",
  sku: "SKU",
  product_master_image: "商品母图",
  folder: "文件夹",
  tag: "标签",
  asset: "素材",
  asset_version: "素材版本",
  dictionary: "字典",
  store: "店铺",
  listing: "上架链接",
  asset_set: "素材组",
  pdp: "PDP 文案",
  export_template: "导出模板",
  release: "正式快照",
  export: "导出包",
  storage: "存储空间",
  storage_provider: "存储空间",
  backup: "备份",
  job: "后台任务",
  trash: "回收站"
};

export const JOB_TYPE_LABELS: Record<JobType, string> = {
  thumbnail: "缩略图生成",
  search_reindex: "全文索引重建",
  export_zip: "上架包 ZIP 导出",
  storage_migrate: "跨存储迁移",
  storage_cleanup: "来源对象清理",
  gc: "回收站安全 GC",
  backup: "系统一致性备份",
  restore: "维护模式恢复"
};

export const VALIDATION_CODE_LABELS: Record<string, string> = {
  FILE_NOT_READY: "文件未就绪",
  STORAGE_OFFLINE: "存储离线",
  FILE_SIZE_MISMATCH: "文件校验异常",
  STORAGE_READ_FAILED: "存储读取失败",
  ASSET_DELETED: "素材已删除",
  FILE_MISSING: "原文件缺失",
  DISALLOWED_EXTENSION: "格式不合规",
  FILE_TOO_LARGE: "体积超限",
  RESOLUTION_BELOW_MIN: "分辨率偏低",
  ASPECT_RATIO_MISMATCH: "比例偏差",
  NEWER_VERSION_AVAILABLE: "存在新版本",
  DUPLICATE_ASSET: "素材重复",
  CAROUSEL_COUNT_TOO_LOW: "轮播数量不足",
  CAROUSEL_BELOW_TARGET: "未达推荐张数",
  CAROUSEL_COUNT_TOO_HIGH: "轮播数量超限",
  DETAIL_COUNT_TOO_LOW: "详情图不足",
  DETAIL_COUNT_TOO_HIGH: "详情图超限",
  NO_LISTING_SKUS: "未绑定 SKU",
  SKU_IMAGE_MISSING: "SKU 缺图",
  VIDEO_COUNT_TOO_HIGH: "视频数量超限",
  PDP_REQUIRED_FIELD_MISSING: "PDP 必填缺失",
  PDP_TITLE_TOO_LONG: "标题超长",
  PDP_SPEC_DIFF: "规格表差异"
};

export const VALIDATION_TARGET_LABELS: Record<NonNullable<ValidationIssue["targetKind"]>, string> = {
  carousel: "轮播图",
  detail: "详情图",
  sku: "SKU 图",
  video: "视频组",
  pdp: "PDP 文案",
  storage: "存储",
  listing: "链接配置"
};

export function formatActivityAction(action: string): string {
  return ACTIVITY_ACTION_LABELS[action] || action;
}

export function formatObjectType(objectType: string): string {
  return OBJECT_TYPE_LABELS[objectType] || objectType;
}

export function formatJobType(jobType: JobType): string {
  return JOB_TYPE_LABELS[jobType] || jobType;
}

export function formatValidationCode(code: string): string {
  return VALIDATION_CODE_LABELS[code] || code;
}
