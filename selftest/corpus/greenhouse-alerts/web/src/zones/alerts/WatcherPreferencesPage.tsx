import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate, useParams } from 'react-router-dom';
import { loadReport, loadWatchers, saveWatchers } from '../../actions/watchers';
import { reportUrl } from '../../http/reportUrl';
import { GreenhouseState } from '../../state/greenhouseState';

export default function WatcherPreferencesPage() {
  const { zoneId = '' } = useParams();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const growers = useSelector((state: GreenhouseState) => state.watchers.growers);
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    dispatch(loadWatchers(zoneId));
  }, [dispatch, zoneId]);

  const handleSave = () => {
    dispatch(saveWatchers(zoneId, selected));
  };

  const handleReport = () => {
    dispatch(loadReport(reportUrl(zoneId, 'watchers')));
  };

  return (
    <form className="watcher-preferences">
      <select multiple value={selected} onChange={(event) => setSelected(Array.from(event.target.selectedOptions, (option) => option.value))}>
        {growers.map((grower) => (
          <option key={grower.id} value={grower.id}>
            {grower.name}
          </option>
        ))}
      </select>
      <button type="button" onClick={handleSave}>
        Save watchers
      </button>
      <button type="button" onClick={handleReport}>
        Download report
      </button>
      <button type="button" onClick={() => navigate(`/greenhouse/zones/${zoneId}/overview`)}>
        Back to overview
      </button>
    </form>
  );
}
