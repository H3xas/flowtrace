import React, { useEffect } from 'react';
import { useDispatch } from 'react-redux';
import { loadGroup } from '../actions/groups';

export default function GroupShell() {
  const dispatch = useDispatch();

  useEffect(() => {
    dispatch(loadGroup('g1'));
  }, [dispatch]);

  return <section className="group-shell">Group</section>;
}
