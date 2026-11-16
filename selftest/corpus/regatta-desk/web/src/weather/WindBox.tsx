import React from 'react';
import { useDispatch } from 'react-redux';
import { loadTide, loadWind } from '../actions/weather';

export default function WindBox() {
  const dispatch = useDispatch();
  dispatch(loadWind());
  return (
    <p className="wind-box">
      <button type="button" onClick={() => dispatch(loadTide('harbor'))}>
        Tide
      </button>
    </p>
  );
}
