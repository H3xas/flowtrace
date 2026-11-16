using System;
using System.Collections.Generic;
using Greenhouse.Alerts.Access;
using Greenhouse.Alerts.Audit;
using Greenhouse.Alerts.Caching;
using Greenhouse.Alerts.DataAccess;
using Greenhouse.Alerts.Eligibility;
using Greenhouse.Alerts.Identity;
using Greenhouse.Alerts.Scheduling;

namespace Greenhouse.Alerts.Services
{
    public interface IWatcherService
    {
        IReadOnlyList<string> ListWatchers(string zoneId);
        ReplaceWatchersResult ReplaceWatchers(string zoneId, IReadOnlyList<string> growerIds);
    }

    public class WatcherService : IWatcherService
    {
        private readonly IGrowerIdentity _identity;
        private readonly IZoneRepository _zones;
        private readonly IZoneAccess _access;
        private readonly IAuditTrail _audit;
        private readonly IWatcherEligibility _eligibility;
        private readonly IWatcherRepository _watchers;
        private readonly IIrrigationSchedules _schedules;
        private readonly IZoneCache _zoneCache;

        public WatcherService(
            IGrowerIdentity identity,
            IZoneRepository zones,
            IZoneAccess access,
            IAuditTrail audit,
            IWatcherEligibility eligibility,
            IWatcherRepository watchers,
            IIrrigationSchedules schedules,
            IZoneCache zoneCache)
        {
            _identity = identity;
            _zones = zones;
            _access = access;
            _audit = audit;
            _eligibility = eligibility;
            _watchers = watchers;
            _schedules = schedules;
            _zoneCache = zoneCache;
        }

        public IReadOnlyList<string> ListWatchers(string zoneId)
        {
            return _watchers.ListWatchers(zoneId);
        }

        public ReplaceWatchersResult ReplaceWatchers(string zoneId, IReadOnlyList<string> growerIds)
        {
            var growerId = _identity.RequireSignedInGrower();
            var zone = _zones.FindZone(zoneId);
            _access.EnsureMayEditZone(growerId, zone);
            _audit.Record(zoneId, "watchers-change-requested");
            var eligible = _eligibility.KeepEligibleWatchers(zone, growerIds);
            if (eligible.Count == 0) throw new ArgumentException("at least one eligible watcher is required", nameof(growerIds));
            _watchers.ReplaceWatchers(zoneId, eligible);
            if (zone.HasIrrigationSchedule)
            {
                _schedules.Recompute(zoneId);
            }

            _zoneCache.Refresh(zoneId);
            _audit.Record(zoneId, "watchers-replaced");
            return new ReplaceWatchersResult
            {
                Stored = eligible.Count == growerIds.Count,
                StoredCount = eligible.Count,
            };
        }
    }
}
