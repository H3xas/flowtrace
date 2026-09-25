using System.Collections.Generic;

namespace Greenhouse.Alerts.Models
{
    public class ReplaceWatchersRequest
    {
        public List<string> GrowerIds { get; set; }
    }

    public class ZoneReading
    {
        public string Sensor { get; set; }
        public double Value { get; set; }
    }
}
