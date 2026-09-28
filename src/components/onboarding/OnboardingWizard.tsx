// 首次启动的设置向导。
//
// 布局是一整屏，而不是一个居中漂浮的小对话框——用户第一次打开软件看到的就是它，
// 500px 的小卡片摆在大窗口里会显得又小又空。这里按 COMSOL 安装程序的样子做：
// 顶部标题条 + 左侧步骤栏 + 右侧内容区，内容区撑满剩余高度，
// 各步骤自己的操作按钮靠 `margin-top: auto` 贴在底部。
import { useState } from "react";
import { X } from "lucide-react";

import appIcon from "../../../src-tauri/icons/icon.png";
import { ClientSelectStep } from "./ClientSelectStep";
import { ComsolDetectStep } from "./ComsolDetectStep";
import { DependencyStep } from "./DependencyStep";
import { DoneStep } from "./DoneStep";
import { WelcomeStep } from "./WelcomeStep";

const STEP_LABELS = ["开始", "检测 COMSOL", "运行环境", "AI 接入说明", "完成"];

interface OnboardingWizardProps {
  onComplete: () => void;
  onClose: () => void;
}

export function OnboardingWizard({ onComplete, onClose }: OnboardingWizardProps) {
  const [step, setStep] = useState(() => {
    const saved = Number(localStorage.getItem("comsolpilot.setupStep") ?? 0);
    return Number.isInteger(saved) ? Math.max(0, Math.min(saved, STEP_LABELS.length - 1)) : 0;
  });
  const goTo = (value: number) => {
    const nextStep = Math.max(0, Math.min(value, STEP_LABELS.length - 1));
    localStorage.setItem("comsolpilot.setupStep", String(nextStep));
    setStep(nextStep);
  };
  const next = () => goTo(step + 1);
  const back = () => goTo(step - 1);

  return (
    <div className="setup-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="setup-dialog" role="dialog" aria-modal="true" aria-labelledby="setup-title">
        <header className="setup-dialog-header">
          <img src={appIcon} alt="" width={19} height={19} draggable={false} />
          <div><strong id="setup-title">开始引导</strong><span>COMSOLPilot 初始配置</span></div>
          <span className="setup-dialog-spacer" />
          <span className="setup-dialog-progress">{step + 1} / {STEP_LABELS.length}</span>
          <button className="setup-close" onClick={onClose} title="关闭引导" aria-label="关闭引导"><X size={17} /></button>
        </header>
        <div className="setup-dialog-body">
          <nav className="setup-rail" aria-label="引导步骤">
            {STEP_LABELS.map((label, index) => (
              <button key={label} className={`setup-step ${index === step ? "is-current" : index < step ? "is-done" : ""}`} onClick={() => index <= step && goTo(index)} disabled={index > step}>
                <span>{index < step ? "✓" : index + 1}</span><strong>{label}</strong>
              </button>
            ))}
          </nav>
          <div className="setup-dialog-content">
            {step === 0 && <WelcomeStep onNext={next} onSkip={onComplete} />}
            {step === 1 && <ComsolDetectStep onNext={next} onBack={back} />}
            {step === 2 && <DependencyStep onNext={next} onBack={back} />}
            {step === 3 && <ClientSelectStep onNext={next} onBack={back} />}
            {step === 4 && <DoneStep onFinish={onComplete} />}
          </div>
        </div>
      </section>
    </div>
  );
}
