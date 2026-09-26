namespace Greenhouse.Alerts.DataAccess
{
    public interface IAirflowRepository
    {
        double FindAirflow(string zoneId);
    }

    public class AirflowRepository : IAirflowRepository
    {
        public double FindAirflow(string zoneId)
        {
            return 0;
        }
    }

    public interface IBrightnessRepository
    {
        double FindBrightness(string zoneId);
    }

    public class BrightnessRepository : IBrightnessRepository
    {
        public double FindBrightness(string zoneId)
        {
            return 0;
        }
    }

    public interface ICarbonRepository
    {
        double FindCarbon(string zoneId);
    }

    public class CarbonRepository : ICarbonRepository
    {
        public double FindCarbon(string zoneId)
        {
            return 0;
        }
    }

    public interface IDewPointRepository
    {
        double FindDewPoint(string zoneId);
    }

    public class DewPointRepository : IDewPointRepository
    {
        public double FindDewPoint(string zoneId)
        {
            return 0;
        }
    }

    public interface IEvaporationRepository
    {
        double FindEvaporation(string zoneId);
    }

    public class EvaporationRepository : IEvaporationRepository
    {
        public double FindEvaporation(string zoneId)
        {
            return 0;
        }
    }

    public interface IFeedRepository
    {
        double FindFeed(string zoneId);
    }

    public class FeedRepository : IFeedRepository
    {
        public double FindFeed(string zoneId)
        {
            return 0;
        }
    }

    public interface IGrowthStageRepository
    {
        double FindGrowthStage(string zoneId);
    }

    public class GrowthStageRepository : IGrowthStageRepository
    {
        public double FindGrowthStage(string zoneId)
        {
            return 0;
        }
    }

    public interface IHumidityRepository
    {
        double FindHumidity(string zoneId);
    }

    public class HumidityRepository : IHumidityRepository
    {
        public double FindHumidity(string zoneId)
        {
            return 0;
        }
    }

    public interface IInfestationRepository
    {
        double FindInfestation(string zoneId);
    }

    public class InfestationRepository : IInfestationRepository
    {
        public double FindInfestation(string zoneId)
        {
            return 0;
        }
    }

    public interface IJunctionValveRepository
    {
        double FindJunctionValve(string zoneId);
    }

    public class JunctionValveRepository : IJunctionValveRepository
    {
        public double FindJunctionValve(string zoneId)
        {
            return 0;
        }
    }

    public interface IKilowattLoadRepository
    {
        double FindKilowattLoad(string zoneId);
    }

    public class KilowattLoadRepository : IKilowattLoadRepository
    {
        public double FindKilowattLoad(string zoneId)
        {
            return 0;
        }
    }

    public interface ILeafTemperatureRepository
    {
        double FindLeafTemperature(string zoneId);
    }

    public class LeafTemperatureRepository : ILeafTemperatureRepository
    {
        public double FindLeafTemperature(string zoneId)
        {
            return 0;
        }
    }
}
