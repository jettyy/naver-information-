/**
 * 대시보드 드롭다운에 띄울 모델 목록.
 * claude CLI 의 --model 에 그대로 넘어간다.
 *
 * 구독 플랜에 따라 쓸 수 없는 모델이 있을 수 있다. 그 경우 CLI 가 오류를 내므로
 * 대시보드에서 다른 모델로 바꾸면 된다.
 */
export const MODELS = [
  {
    id: '',
    label: '기본값 (claude CLI 설정을 따름)',
    note: '지정하지 않으면 CLI 가 알아서 고릅니다.',
  },
  {
    id: 'claude-opus-5',
    label: 'Opus 5 — 가장 똑똑함 (글 품질 우선)',
    note: '1,800자 이상 긴 글에서 문체와 구조를 가장 잘 지킵니다. 대신 느립니다.',
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5 — 균형 (권장)',
    note: '정보성 글 길이를 안정적으로 채우면서 속도도 쓸 만합니다.',
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5 — 가장 빠름',
    note: '빠르지만 1,800자 이상 + 표 + 항목별 상세를 한 번에 채우기엔 약합니다.',
  },
  {
    id: 'claude-fable-5-1',
    label: 'Fable 5.1 — 최고 성능',
    note: '가장 강력하지만 느리고, 플랜에 따라 사용이 막힐 수 있습니다.',
  },
  {
    id: 'claude-opus-4-8',
    label: 'Opus 4.8 — 이전 세대 Opus',
    note: 'Opus 5 가 안 될 때의 대안입니다.',
  },
];

export const MODEL_IDS = new Set(MODELS.map((model) => model.id).filter(Boolean));

/** 사람이 읽을 이름. 기록해둔 모델 ID 를 대시보드에 표시할 때 쓴다. */
export function modelLabel(id) {
  if (!id) return '기본값';
  const known = MODELS.find((model) => model.id === id);
  if (known) return known.label.split(' — ')[0];
  return id;
}
