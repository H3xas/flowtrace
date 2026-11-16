using System.Collections.Generic;

namespace Greenhouse.Alerts.Scheduling
{
    public interface IIrrigationSchedules
    {
        void Recompute(string zoneId);
    }

    public class IrrigationSchedules : IIrrigationSchedules
    {
        public HashSet<string> Pending { get; } = new HashSet<string>();

        public void Recompute(string zoneId)
        {
            Pending.Add(zoneId);
        }
    }
}
