import { Component } from '@angular/core';
import { ZoneWatcherFeed } from './zone-watcher-feed.service';

@Component({
  selector: 'app-zone-watchers-page',
  templateUrl: './zone-watchers.page.html',
})
export class ZoneWatchersPage {
  constructor(private feed: ZoneWatcherFeed) {}

  refresh(zoneId: string) {
    this.feed.listWatchers(zoneId);
  }
}
