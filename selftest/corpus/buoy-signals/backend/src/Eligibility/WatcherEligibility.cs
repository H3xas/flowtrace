using System.Collections.Generic;
using System.Linq;
using Greenhouse.Alerts.Models;

namespace Greenhouse.Alerts.Eligibility
{
    public interface IWatcherEligibility
    {
        IReadOnlyList<string> KeepEligibleWatchers(Zone zone, IReadOnlyList<string> growerIds);
    }

    public class WatcherEligibility : IWatcherEligibility
    {
        public IReadOnlyList<string> KeepEligibleWatchers(Zone zone, IReadOnlyList<string> growerIds)
        {
            return growerIds.Where(id => zone.EditorIds.Contains(id) || zone.ViewerIds.Contains(id)).ToList();
        }
    }
}
