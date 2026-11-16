import { Injectable } from '@angular/core';
import { PassageApiService } from './passage-api.service';

@Injectable({ providedIn: 'root' })
export class PassageDeskService {
  constructor(private api: PassageApiService) {}

  submit(form: PassageForm, x: Passage) {
    if (form.valid) {
      this.api.save(x);
    }
  }

  elseArm(ready: boolean, x: Passage) {
    if (ready) {
      this.api.load(x.id);
    } else {
      this.api.save(x);
    }
  }

  elseIf(first: boolean, second: boolean, x: Passage) {
    if (first) {
      this.api.load(x.id);
    } else if (second) {
      this.api.save(x);
    }
  }

  clause(kind: string, x: Passage) {
    switch (kind) {
      case 'new':
        this.api.save(x);
        break;
      case 'seen':
        x.seen = true;
      case 'kept':
        this.api.load(x.id);
        break;
    }
  }

  ternaryArm(open: boolean, x: Passage) {
    return open ? this.api.save(x) : this.api.load(x.id);
  }

  andRight(open: boolean, x: Passage) {
    open && this.api.save(x);
  }

  orRight(cached: boolean, x: Passage) {
    cached || this.api.save(x);
  }

  coalesceRight(held: Passage | null, x: Passage) {
    return held ?? this.api.save(x);
  }

  ranked(first: boolean, second: boolean, x: Passage) {
    first && second || this.api.save(x);
  }

  mixed(first: boolean, second: boolean, x: Passage) {
    first || second && this.api.save(x);
  }

  display(open: boolean, x: Passage) {
    const label = open ? 'open' : 'shut';
    this.api.save({ ...x, label });
  }

  inCondition(x: Passage) {
    if (this.api.load(x.id)) {
      x.seen = true;
    }
  }

  returnExit(form: PassageForm, x: Passage) {
    if (form.invalid) {
      return;
    }
    this.api.save(x);
  }

  throwExit(form: PassageForm, x: Passage) {
    if (form.invalid) {
      throw new Error('invalid passage');
    }
    this.api.save(x);
  }

  blockExit(form: PassageForm, x: Passage) {
    if (form.ready) {
      if (form.invalid) {
        return;
      }
      this.api.save(x);
    }
  }

  callbackExit(form: PassageForm, x: Passage) {
    form.rows.forEach((row) => {
      if (row.invalid) {
        return;
      }
    });
    this.api.save(x);
  }

  guard(form: PassageForm) {
    if (form.invalid) {
      return;
    }
  }

  otherMethodExit(form: PassageForm, x: Passage) {
    this.guard(form);
    this.api.save(x);
  }

  partialExit(form: PassageForm, x: Passage) {
    if (form.ready) {
      if (form.invalid) {
        return;
      }
    }
    this.api.save(x);
  }

  oneArmExit(form: PassageForm, x: Passage) {
    if (form.valid) {
      form.touched = true;
    } else {
      return;
    }
    this.api.save(x);
  }

  breakExit(rows: Passage[]) {
    for (const row of rows) {
      if (row.invalid) {
        break;
      }
      this.api.save(row);
    }
  }

  continueExit(rows: Passage[]) {
    for (const row of rows) {
      if (row.invalid) {
        continue;
      }
      this.api.save(row);
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
    this.api.save(x);
  }

  catchExit(form: PassageForm, x: Passage) {
    try {
      form.checked = true;
    } catch (error) {
      if (form.strict) {
        return;
      }
    }
    this.api.save(x);
  }

  sameRoute(open: boolean, x: Passage) {
    this.api.save(x);
    if (open) {
      this.api.save(x);
    }
  }

  oneLine(open: boolean, x: Passage, y: Passage) {
    if (open) { this.api.save(x); } else { this.api.save(y); }
  }

  lineMix(open: boolean, x: Passage) {
    if (open) { this.api.save(x); } this.api.load(x.id);
  }

  groupedAnd(open: boolean, held: boolean, x: Passage) {
    (open && this.api.save(x)) || held;
  }

  groupedCoalesce(held: Passage | null, kept: Passage | null, x: Passage) {
    (held ?? this.api.save(x)) ?? kept;
  }

  elseBlockExit(form: PassageForm, x: Passage) {
    if (form.invalid) {
      return;
    } else {
      if (form.stale) {
        return;
      }
    }
    this.api.save(x);
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
    this.api.save(x);
  }

  classExit(form: PassageForm, x: Passage) {
    class Check {
      run() {
        if (form.invalid) {
          return;
        }
      }
    }
    this.api.save(x);
  }

  argumentAnd(open: boolean, held: boolean, kept: boolean, x: Passage) {
    check(open && held, this.api.save(x)) || kept;
  }

  commaAnd(open: boolean, held: boolean, kept: boolean, x: Passage) {
    (open && held, this.api.save(x)) || kept;
  }

  ternaryAnd(open: boolean, held: boolean, kept: boolean, x: Passage) {
    (open ? held && kept : this.api.save(x)) || held;
  }

  typedHelperExit(form: PassageForm, x: Passage) {
    const helper = {
      check(): { ok: boolean } {
        if (form.invalid) {
          return { ok: false };
        }
        return { ok: true };
      },
      run(): Promise<{ ok: boolean }> {
        if (form.stale) {
          return Promise.resolve({ ok: false });
        }
        return Promise.resolve({ ok: true });
      },
      'audit'() {
        if (form.invalid) {
          return;
        }
      },
      catch() {
        if (form.stale) {
          return;
        }
      },
    };
    function checked(): { ok: boolean } {
      if (form.invalid) {
        return { ok: false };
      }
      return { ok: true };
    }
    this.api.save(x);
  }

  staticBlockExit(form: PassageForm, x: Passage) {
    class Guard {
      static {
        if (form.invalid) {
          throw new Error('invalid');
        }
      }
    }
    this.api.save(x);
  }

  rankedLoad(open: boolean, x: Passage) {
    this.api.load(x.id);
    open && this.api.save(x) || this.api.load(x.id);
  }
}
