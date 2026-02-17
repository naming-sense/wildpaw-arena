interface MatchResultViewProps {
  visible: boolean;
}

export function MatchResultView({ visible }: MatchResultViewProps): JSX.Element | null {
  if (!visible) return null;
  return (
    <div className="overlay-panel">
      <h3>MATCH RESULT (placeholder)</h3>
      <p>팀 점수/개인 기여도/리매치 버튼을 여기에 배치합니다.</p>
    </div>
  );
}
