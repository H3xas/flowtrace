import React, { useEffect } from 'react';
import { useDispatch } from 'react-redux';
import { loadResults, refreshResults } from '../actions/regattas';

export default function ResultsBoard() {
  const dispatch = useDispatch();

  useEffect(() => {
    dispatch(loadResults());
  }, [dispatch]);

  return (
    <section className="results-board">
      <button type="button" onClick={() => dispatch(refreshResults('r1'))}>
        Refresh
      </button>
    </section>
  );
}
