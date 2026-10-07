import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { loadWatchers } from '../../actions/watchers';
import { loadZoneReadings } from '../../actions/zoneReadings';
import { GreenhouseState } from '../../state/greenhouseState';

interface WatcherNotesPanelProps {
  onRefresh?: () => void;
}

const useNoteDraft = (initial: string) => {
  const [draft, setDraft] = useState(initial);
  return { draft, setDraft };
};

export default function WatcherNotesPanel(props: WatcherNotesPanelProps) {
  const dispatch = useDispatch();
  const readings = useSelector((state: GreenhouseState) => state.zoneReadings.items);
  const { draft, setDraft } = useNoteDraft('');

  const refresh = () => {
    dispatch(loadZoneReadings('latest'));
  };

  useEffect(() => {
    dispatch(loadWatchers('latest'));
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDraft(draft.trim()), 5000);
    return () => {
      clearTimeout(timer);
    };
  }, [draft]);

  useEffect(refresh, [readings]);

  useEffect(props.onRefresh, []);

  return (
    <section className="watcher-notes">
      <span>{readings.length} readings</span>
    </section>
  );
}
