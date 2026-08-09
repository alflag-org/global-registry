import type { Actor } from '../domain/models/global-registry';
import type { PrincipalType } from '../domain/actor/identity';

export const actorRoleLabels: Readonly<Record<Actor['role'], string>> = {
  admin: '管理者',
  provisioner: 'プロビジョナー',
  observer: 'オブザーバー',
  validator: '検証者',
  operator: 'オペレーター',
  readonly: '閲覧専用',
};

export function principalTypeLabel(type: PrincipalType): string {
  return type === 'human' ? '人間' : 'サービス';
}

const valueLabels: Readonly<Record<string, string>> = {
  absent: '未登録',
  allocated: '割り当て済み',
  bootstrapped: 'ブートストラップ済み',
  configured: '構成済み',
  initialized: '初期化済み',
  integrated: '統合済み',
  ready: '準備完了',
  serving: '提供中',
  draining: '停止処理中',
  offline: 'オフライン',
  stopped: '停止',
  retired: '廃止',
  unknown: '不明',
  healthy: '正常',
  degraded: '注意',
  unhealthy: '異常',
  open: '未解決',
  acknowledged: '確認済み',
  resolved: '解決済み',
  planned: '計画済み',
  running: '実行中',
  succeeded: '成功',
  failed: '失敗',
  blocked: 'ブロック中',
  cancelled: 'キャンセル済み',
  skipped: 'スキップ',
  published: '公開済み',
  active: '有効',
  inactive: '無効',
  disabled: '無効',
  deprecated: '非推奨',
  low: '低',
  medium: '中',
  high: '高',
  critical: '重大',
  location: 'ロケーション',
  network: 'ネットワーク',
  compute: 'コンピュート',
  volume: 'ボリューム',
  service_cluster: 'サービスクラスター',
  service_instance: 'サービスインスタンス',
  endpoint: 'エンドポイント',
  backup_repository: 'バックアップリポジトリ',
  member_of: '所属',
  hosted_on: 'ホスト先',
  uses_network: 'ネットワークを使用',
  uses_volume: 'ボリュームを使用',
  exposes_endpoint: 'エンドポイントを公開',
  depends_on: '依存',
  backed_up_to: 'バックアップ先',
  replacement_for: '置換対象',
  lifecycle_transition: 'ライフサイクル遷移',
  'actor.created': 'アクター作成',
  'actor.updated': 'アクター更新',
  'resource.created': 'リソース作成',
  'resource.updated': 'リソース更新',
  'provider.created': 'プロバイダー作成',
  'provider.updated': 'プロバイダー更新',
  'profile.created': 'プロファイル作成',
  'profile.version_created': 'プロファイル版作成',
  'policy.created': 'ポリシー作成',
  'policy.version_created': 'ポリシー版作成',
  'binding.replaced': '紐付け変更',
  'binding.removed': '紐付け解除',
  'relationship.created': '関係作成',
  'relationship.removed': '関係解除',
  'health.updated': 'ヘルス更新',
  'observation.recorded': '観測記録',
  'observation.archived': '観測アーカイブ',
  'drift.created': 'ドリフト作成',
  'drift.updated': 'ドリフト更新',
  'operation.planned': '操作計画',
  'operation.running': '操作開始',
  'operation.succeeded': '操作成功',
  'operation.failed': '操作失敗',
  'operation.blocked': '操作ブロック',
  'operation.cancelled': '操作キャンセル',
  'operation.step_updated': '操作ステップ更新',
  'lock.acquired': 'ロック取得',
  'lock.renewed': 'ロック更新',
  'lock.released': 'ロック解放',
  'lifecycle.transition': 'ライフサイクル遷移',
  'export.requested': 'エクスポート要求',
  'export.expired': 'エクスポート期限切れ',
};

export function escapeHtml(value: unknown): string {
  const text = value === null || value === undefined ? '—' : String(value);
  return text.replace(/[&<>'"]/g, (character) => {
    const entities: Readonly<Record<string, string>> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    };
    return entities[character] ?? character;
  });
}

export function escapeHtmlAttribute(value: unknown): string {
  return escapeHtml(value);
}

export function labelValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  const text = String(value);
  return valueLabels[text] ?? text;
}

export function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined || value.length === 0) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ja-JP', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Tokyo',
  }).format(date);
}

export function pathSegment(value: string): string {
  return encodeURIComponent(value);
}
