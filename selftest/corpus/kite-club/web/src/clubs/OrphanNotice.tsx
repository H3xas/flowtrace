import React from 'react';
import { useDispatch } from 'react-redux';
import { joinClub } from '../actions/clubs';

export function OrphanNotice() {
  const dispatch = useDispatch();
  dispatch(joinClub('orphan'));
  return <p className="orphan-notice">Joined</p>;
}
