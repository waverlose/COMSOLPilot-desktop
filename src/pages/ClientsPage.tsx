import { ClientSetupPanel } from "../components/ClientSetupPanel";

export function ClientsPage({ refreshKey = 0 }: { refreshKey?: number }) {
  return <div className="page"><ClientSetupPanel mode="page" refreshKey={refreshKey} /></div>;
}
