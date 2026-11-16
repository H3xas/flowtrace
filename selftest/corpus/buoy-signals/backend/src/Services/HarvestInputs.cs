using Greenhouse.Alerts.DataAccess;

namespace Greenhouse.Alerts.Services
{
    public interface IAirflowInputs
    {
        double Load(string zoneId);
    }

    public class AirflowInputs : IAirflowInputs
    {
        private readonly IAirflowRepository _source;

        public AirflowInputs(IAirflowRepository source)
        {
            _source = source;
        }

        public double Load(string zoneId)
        {
            return _source.FindAirflow(zoneId);
        }
    }

    public interface IBrightnessInputs
    {
        double Load(string zoneId);
    }

    public class BrightnessInputs : IBrightnessInputs
    {
        private readonly IBrightnessRepository _source;

        public BrightnessInputs(IBrightnessRepository source)
        {
            _source = source;
        }

        public double Load(string zoneId)
        {
            return _source.FindBrightness(zoneId);
        }
    }

    public interface ICarbonInputs
    {
        double Load(string zoneId);
    }

    public class CarbonInputs : ICarbonInputs
    {
        private readonly ICarbonRepository _source;

        public CarbonInputs(ICarbonRepository source)
        {
            _source = source;
        }

        public double Load(string zoneId)
        {
            return _source.FindCarbon(zoneId);
        }
    }

    public interface IDewPointInputs
    {
        double Load(string zoneId);
    }

    public class DewPointInputs : IDewPointInputs
    {
        private readonly IDewPointRepository _source;

        public DewPointInputs(IDewPointRepository source)
        {
            _source = source;
        }

        public double Load(string zoneId)
        {
            return _source.FindDewPoint(zoneId);
        }
    }

    public interface IEvaporationInputs
    {
        double Load(string zoneId);
    }

    public class EvaporationInputs : IEvaporationInputs
    {
        private readonly IEvaporationRepository _source;

        public EvaporationInputs(IEvaporationRepository source)
        {
            _source = source;
        }

        public double Load(string zoneId)
        {
            return _source.FindEvaporation(zoneId);
        }
    }

    public interface IFeedInputs
    {
        double Load(string zoneId);
    }

    public class FeedInputs : IFeedInputs
    {
        private readonly IFeedRepository _source;

        public FeedInputs(IFeedRepository source)
        {
            _source = source;
        }

        public double Load(string zoneId)
        {
            return _source.FindFeed(zoneId);
        }
    }

    public interface IGrowthStageInputs
    {
        double Load(string zoneId);
    }

    public class GrowthStageInputs : IGrowthStageInputs
    {
        private readonly IGrowthStageRepository _source;

        public GrowthStageInputs(IGrowthStageRepository source)
        {
            _source = source;
        }

        public double Load(string zoneId)
        {
            return _source.FindGrowthStage(zoneId);
        }
    }

    public interface IHumidityInputs
    {
        double Load(string zoneId);
    }

    public class HumidityInputs : IHumidityInputs
    {
        private readonly IHumidityRepository _source;

        public HumidityInputs(IHumidityRepository source)
        {
            _source = source;
        }

        public double Load(string zoneId)
        {
            return _source.FindHumidity(zoneId);
        }
    }

    public interface IInfestationInputs
    {
        double Load(string zoneId);
    }

    public class InfestationInputs : IInfestationInputs
    {
        private readonly IInfestationRepository _source;

        public InfestationInputs(IInfestationRepository source)
        {
            _source = source;
        }

        public double Load(string zoneId)
        {
            return _source.FindInfestation(zoneId);
        }
    }

    public interface IJunctionValveInputs
    {
        double Load(string zoneId);
    }

    public class JunctionValveInputs : IJunctionValveInputs
    {
        private readonly IJunctionValveRepository _source;

        public JunctionValveInputs(IJunctionValveRepository source)
        {
            _source = source;
        }

        public double Load(string zoneId)
        {
            return _source.FindJunctionValve(zoneId);
        }
    }

    public interface IKilowattLoadInputs
    {
        double Load(string zoneId);
    }

    public class KilowattLoadInputs : IKilowattLoadInputs
    {
        private readonly IKilowattLoadRepository _source;

        public KilowattLoadInputs(IKilowattLoadRepository source)
        {
            _source = source;
        }

        public double Load(string zoneId)
        {
            return _source.FindKilowattLoad(zoneId);
        }
    }

    public interface ILeafTemperatureInputs
    {
        double Load(string zoneId);
    }

    public class LeafTemperatureInputs : ILeafTemperatureInputs
    {
        private readonly ILeafTemperatureRepository _source;

        public LeafTemperatureInputs(ILeafTemperatureRepository source)
        {
            _source = source;
        }

        public double Load(string zoneId)
        {
            return _source.FindLeafTemperature(zoneId);
        }
    }
}
