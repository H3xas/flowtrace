import * as api from '../api';

export class PassageDesk {
  submit(form: PassageForm, x: Passage) {
    if (form.valid) {
      api.save(x);
    }
  }

  elseArm(ready: boolean, x: Passage) {
    if (ready) {
      api.load(x.id);
    } else {
      api.save(x);
    }
  }

  elseIf(first: boolean, second: boolean, x: Passage) {
    if (first) {
      api.load(x.id);
    } else if (second) {
      api.save(x);
    }
  }

  clause(kind: string, x: Passage) {
    switch (kind) {
      case 'new':
        api.save(x);
        break;
      case 'seen':
        x.seen = true;
      case 'kept':
        api.load(x.id);
        break;
    }
  }

  ternaryArm(open: boolean, x: Passage) {
    return open ? api.save(x) : api.load(x.id);
  }

  andRight(open: boolean, x: Passage) {
    open && api.save(x);
  }

  orRight(cached: boolean, x: Passage) {
    cached || api.save(x);
  }

  coalesceRight(held: Passage | null, x: Passage) {
    return held ?? api.save(x);
  }

  ranked(first: boolean, second: boolean, x: Passage) {
    first && second || api.save(x);
  }

  mixed(first: boolean, second: boolean, x: Passage) {
    first || second && api.save(x);
  }

  display(open: boolean, x: Passage) {
    const label = open ? 'open' : 'shut';
    api.save({ ...x, label });
  }

  inCondition(x: Passage) {
    if (api.load(x.id)) {
      x.seen = true;
    }
  }

  returnExit(form: PassageForm, x: Passage) {
    if (form.invalid) {
      return;
    }
    api.save(x);
  }

  throwExit(form: PassageForm, x: Passage) {
    if (form.invalid) {
      throw new Error('invalid passage');
    }
    api.save(x);
  }

  blockExit(form: PassageForm, x: Passage) {
    if (form.ready) {
      if (form.invalid) {
        return;
      }
      api.save(x);
    }
  }

  callbackExit(form: PassageForm, x: Passage) {
    form.rows.forEach((row) => {
      if (row.invalid) {
        return;
      }
    });
    api.save(x);
  }

  guard(form: PassageForm) {
    if (form.invalid) {
      return;
    }
  }

  otherMethodExit(form: PassageForm, x: Passage) {
    this.guard(form);
    api.save(x);
  }

  partialExit(form: PassageForm, x: Passage) {
    if (form.ready) {
      if (form.invalid) {
        return;
      }
    }
    api.save(x);
  }

  oneArmExit(form: PassageForm, x: Passage) {
    if (form.valid) {
      form.touched = true;
    } else {
      return;
    }
    api.save(x);
  }

  breakExit(rows: Passage[]) {
    for (const row of rows) {
      if (row.invalid) {
        break;
      }
      api.save(row);
    }
  }

  continueExit(rows: Passage[]) {
    for (const row of rows) {
      if (row.invalid) {
        continue;
      }
      api.save(row);
    }
  }

  tryExit(form: PassageForm, x: Passage) {
    try {
      if (form.invalid) {
        return;
      }
    } finally {
      form.checked = true;
    }
    api.save(x);
  }

  catchExit(form: PassageForm, x: Passage) {
    try {
      form.checked = true;
    } catch (error) {
      if (form.strict) {
        return;
      }
    }
    api.save(x);
  }

  sameRoute(open: boolean, x: Passage) {
    api.save(x);
    if (open) {
      api.save(x);
    }
  }

  oneLine(open: boolean, x: Passage, y: Passage) {
    if (open) { api.save(x); } else { api.save(y); }
  }

  lineMix(open: boolean, x: Passage) {
    if (open) { api.save(x); } api.load(x.id);
  }

  groupedAnd(open: boolean, held: boolean, x: Passage) {
    (open && api.save(x)) || held;
  }

  groupedCoalesce(held: Passage | null, kept: Passage | null, x: Passage) {
    (held ?? api.save(x)) ?? kept;
  }

  elseBlockExit(form: PassageForm, x: Passage) {
    if (form.invalid) {
      return;
    } else {
      if (form.stale) {
        return;
      }
    }
    api.save(x);
  }

  helperExit(form: PassageForm, x: Passage) {
    const helper = {
      check() {
        if (form.invalid) {
          return;
        }
      },
      get ready() {
        if (form.stale) {
          return false;
        }
        return true;
      },
    };
    api.save(x);
  }

  classExit(form: PassageForm, x: Passage) {
    class Check {
      run() {
        if (form.invalid) {
          return;
        }
      }
    }
    api.save(x);
  }
}
