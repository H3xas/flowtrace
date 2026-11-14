import { useEffect, useState } from 'react';
import { loadBoarding } from '../actions/boarding';

export function BoardingPanel(props: { ferryId: string; permit: boolean; routes: string[] }) {
  const [boarding, setBoarding] = useState(null);

  useEffect(() => {
    const load = async () => {
      const loaded = await loadBoarding(props.ferryId, props.permit, props.routes);
      setBoarding(loaded);
    };
    load();
  }, [props.ferryId]);

  const refresh = () => {
    scheduleLater(() => loadBoarding(props.ferryId, true, props.routes));
  };

  return (
    <section>
      <button onClick={refresh}>Refresh</button>
    </section>
  );
}

function scheduleLater(work: () => Promise<unknown>) {
  setTimeout(work, 0);
}
