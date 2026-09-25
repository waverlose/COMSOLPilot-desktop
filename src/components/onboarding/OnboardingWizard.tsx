// 首次启动的设置向导。
//
// 布局是一整屏，而不是一个居中漂浮的小对话框——用户第一次打开软件看到的就是它，
// 500px 的小卡片摆在大窗口里会显得又小又空。这里按 COMSOL 安装程序的样子做：
// 顶部标题条 + 左侧步骤栏 + 右侧内容区，内容区撑满剩余高度，
// 各步骤自己的操作按钮靠 `margin-top: auto` 贴在底部。
import { useState } from "react";

import appIcon from "../../assets/app-icon.png";
import { ClientSelectStep } from "./ClientSelectStep";
import { ComsolDetectStep } from "./ComsolDetectStep";
import { DependencyStep } from "./DependencyStep";
import { DoneStep } from "./DoneStep";
import { WelcomeStep } from "./WelcomeStep";

const STEP_LABELS = ["欢迎", "检测 COMSOL", "环境依赖", "接入 AI 客户端", "完成"];

interface OnboardingWizardProps {
  onComplete: () => void;
}

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const [step, setStep] = useState(0);
  const next = () => setStep((s) => Math.min(s + 1, STEP_LABELS.length - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));

  return (
    <div className="wizard">
      <header className="wizard-titlebar">
        <img src={appIcon} alt="" width={17} height={17} draggable={false} />
        <span className="wizard-titlebar-text">COMSOLPilot 设置向导</span>
        <span className="wizard-titlebar-spacer" />
        <span className="wizard-titlebar-step">
          第 {step + 1} / {STEP_LABELS.length} 步
        </span>
      </header>

      <div className="wizard-body">
        <nav className="wizard-rail">
          <div className="wizard-rail-head">设置步骤</div>
          <ol className="wizard-steps">
            {STEP_LABELS.map((label, index) => (
              <li
                key={label}
                className={[
                  "wizard-step",
                  index === step ? "is-current" : "",
                  index < step ? "is-done" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <span className="wizard-step-no">{index < step ? "✓" : index + 1}</span>
                <span className="wizard-step-label">{label}</span>
              </li>
            ))}
          </ol>
          <div className="wizard-rail-foot">
            全程约 3-5 分钟
            <br />
            随时可以从「文件 → 重新运行设置向导」回来
          </div>
        </nav>

        <section className="wizard-content">
          {step === 0 && <WelcomeStep onNext={next} />}
          {step === 1 && <ComsolDetectStep onNext={next} onBack={back} />}
          {step === 2 && <DependencyStep onNext={next} onBack={back} />}
          {step === 3 && <ClientSelectStep onNext={next} onBack={back} />}
          {step === 4 && <DoneStep onFinish={onComplete} />}
        </section>
      </div>
    </div>
  );
}
