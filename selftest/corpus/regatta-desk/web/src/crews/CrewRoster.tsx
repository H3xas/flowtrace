import React from 'react';
import { connect } from 'react-redux';
import { loadCrew, signUpCrew } from '../actions/crews';
import { ActionButton } from '../layout/ActionButton';

interface CrewRosterProps {
  crewId: string;
  loadCrew: (crewId: string) => void;
  signUpCrew: (crewId: string) => void;
}

function CrewRoster(props: CrewRosterProps) {
  props.loadCrew(props.crewId);
  const onSignUp = () => props.signUpCrew(props.crewId);
  return (
    <section className="crew-roster">
      <ActionButton label="Sign up" action={onSignUp} />
    </section>
  );
}

export default connect(null, { loadCrew, signUpCrew })(CrewRoster);
