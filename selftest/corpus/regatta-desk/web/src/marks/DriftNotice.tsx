import React from 'react';
import { connect } from 'react-redux';
import { loadMark } from '../actions/marks';

interface DriftNoticeProps {
  loadMark: (markId: string) => void;
}

function DriftNotice(props: DriftNoticeProps) {
  props.loadMark('m3');
  return <p className="drift-notice">Mark drifted</p>;
}

export default connect(null, { loadMark })(DriftNotice);
