using Greenhouse.Alerts.Models;

namespace Greenhouse.Alerts.Services
{
    public interface IHarvestPlanner
    {
        HarvestPlan CommitPlan(string zoneId);
    }

    public class HarvestPlanner : IHarvestPlanner
    {
        private readonly IAirflowInputs _airflow;
        private readonly IBrightnessInputs _brightness;
        private readonly ICarbonInputs _carbon;
        private readonly IDewPointInputs _dewPoint;
        private readonly IEvaporationInputs _evaporation;
        private readonly IFeedInputs _feed;
        private readonly IGrowthStageInputs _growthStage;
        private readonly IHumidityInputs _humidity;
        private readonly IInfestationInputs _infestation;
        private readonly IJunctionValveInputs _junctionValve;
        private readonly IKilowattLoadInputs _kilowattLoad;
        private readonly ILeafTemperatureInputs _leafTemperature;
        private readonly IHarvestPlanWriter _planWriter;

        public HarvestPlanner(
            IAirflowInputs airflow,
            IBrightnessInputs brightness,
            ICarbonInputs carbon,
            IDewPointInputs dewPoint,
            IEvaporationInputs evaporation,
            IFeedInputs feed,
            IGrowthStageInputs growthStage,
            IHumidityInputs humidity,
            IInfestationInputs infestation,
            IJunctionValveInputs junctionValve,
            IKilowattLoadInputs kilowattLoad,
            ILeafTemperatureInputs leafTemperature,
            IHarvestPlanWriter planWriter)
        {
            _airflow = airflow;
            _brightness = brightness;
            _carbon = carbon;
            _dewPoint = dewPoint;
            _evaporation = evaporation;
            _feed = feed;
            _growthStage = growthStage;
            _humidity = humidity;
            _infestation = infestation;
            _junctionValve = junctionValve;
            _kilowattLoad = kilowattLoad;
            _leafTemperature = leafTemperature;
            _planWriter = planWriter;
        }

        public HarvestPlan CommitPlan(string zoneId)
        {
            var airflow = _airflow.Load(zoneId);
            var brightness = _brightness.Load(zoneId);
            var carbon = _carbon.Load(zoneId);
            var dewPoint = _dewPoint.Load(zoneId);
            var evaporation = _evaporation.Load(zoneId);
            var feed = _feed.Load(zoneId);
            var growthStage = _growthStage.Load(zoneId);
            var humidity = _humidity.Load(zoneId);
            var infestation = _infestation.Load(zoneId);
            var junctionValve = _junctionValve.Load(zoneId);
            var kilowattLoad = _kilowattLoad.Load(zoneId);
            var leafTemperature = _leafTemperature.Load(zoneId);
            var plan = HarvestPlan.Compose(zoneId, new[] { airflow, brightness, carbon, dewPoint, evaporation, feed, growthStage, humidity, infestation, junctionValve, kilowattLoad, leafTemperature });
            _planWriter.SavePlan(plan);
            return plan;
        }
    }
}
