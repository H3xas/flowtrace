using System.Collections.Generic;

namespace Greenhouse.Alerts.Audit
{
    public interface IAuditTrail
    {
        void Record(string zoneId, string action);
    }

    public class AuditTrail : IAuditTrail
    {
        public List<string> Entries { get; } = new List<string>();

        public void Record(string zoneId, string action)
        {
            Entries.Add(zoneId + ":" + action);
        }
    }
}
