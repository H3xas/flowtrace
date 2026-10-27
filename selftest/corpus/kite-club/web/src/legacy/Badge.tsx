import React from 'react';
import { useDispatch } from 'react-redux';
import { joinClub } from '../actions/clubs';

export function Badge() {
  const dispatch = useDispatch();
  dispatch(joinClub('legacy'));
  return <span className="badge legacy">Member</span>;
}
