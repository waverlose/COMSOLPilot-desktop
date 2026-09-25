import { useState } from "react";
import { WelcomeStep } from "./WelcomeStep";
import { ComsolDetectStep } from "./ComsolDetectStep";
import { DependencyStep } from "./DependencyStep";
import { ClientSelectStep } from "./ClientSelectStep";
import { DoneStep } from "./DoneStep";

const STEP_LABELS = ["欢迎", "检测 COMSOL", "环境依赖", "接入 AI 客户端", "完成"];

interface OnboardingWizardProps {
  onComplete: () => void;
}

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const [step, setStep] = useState(0);
  const next = () => setStep((s) => Math.min(s + 1, STEP_LABELS.length - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));

  return (
    <div className="onboarding-shell">
      <div className="onboarding-progress">
        {STEP_LABELS.map((label, i) => (
          <div key={label} className={`progress-dot ${i <= step ? "is-filled" : ""}`} />
        ))}
        <span className="progress-label">
          第 {step + 1} / {STEP_LABELS.length} 步
        </span>
      </div>

      <div className="onboarding-card">
        <div className="onboarding-card-title">
          COMSOLPilot 设置向导 — {STEP_LABELS[step]}
        </div>
        {step === 0 && <WelcomeStep onNext={next} />}
        {step === 1 && <ComsolDetectStep onNext={next} onBack={back} />}
        {step === 2 && <DependencyStep onNext={next} onBack={back} />}
        {step === 3 && <ClientSelectStep onNext={next} onBack={back} />}
        {step === 4 && <DoneStep onFinish={onComplete} />}
      </div>
    </div>
  );
}
