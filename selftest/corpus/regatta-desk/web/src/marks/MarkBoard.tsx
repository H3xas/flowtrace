import React from 'react';
import { useDispatch } from 'react-redux';
import { roundMark, skipMark } from '../actions/marks';

export default function MarkBoard() {
  const dispatch = useDispatch();
  return (
    <div className="mark-board">
      <button type="button" onClick={() => dispatch(roundMark('m1'))}>
        Round
      </button>
      <button
        type="button"
        onClick={() =>
          dispatch(
            skipMark('m2'),
          )
        }
      >
        Skip
      </button>
    </div>
  );
}
