import React, { useEffect } from 'react';
import { useDispatch } from 'react-redux';
import { joinClub } from '../actions/clubs';

export default function JoinPage() {
  const dispatch = useDispatch();

  useEffect(() => {
    dispatch(joinClub('welcome'));
  }, [dispatch]);

  return <p className="join-page">Joining</p>;
}
