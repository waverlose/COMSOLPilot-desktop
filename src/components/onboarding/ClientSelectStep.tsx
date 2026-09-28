import { ClientSetupPanel } from "../ClientSetupPanel";

interface Props {
  onNext: () => void;
  onBack: () => void;
}

export function ClientSelectStep({ onNext, onBack }: Props) {
  return <ClientSetupPanel mode="wizard" onNext={onNext} onBack={onBack} />;
}
