using System.Collections.Generic;

namespace Greenhouse.Alerts.DataAccess
{
    public interface IWatcherRepository
    {
        IReadOnlyList<string> ListWatchers(string zoneId);
        void ReplaceWatchers(string zoneId, IReadOnlyList<string> growerIds);
    }

    public class WatcherRepository : IWatcherRepository
    {
        public IReadOnlyList<string> ListWatchers(string zoneId)
        {
            return new List<string>();
        }

        public void ReplaceWatchers(string zoneId, IReadOnlyList<string> growerIds)
        {
        }
    }
}
