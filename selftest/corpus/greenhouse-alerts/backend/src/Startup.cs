using Greenhouse.Alerts.Access;
using Greenhouse.Alerts.Audit;
using Greenhouse.Alerts.Caching;
using Greenhouse.Alerts.DataAccess;
using Greenhouse.Alerts.Eligibility;
using Greenhouse.Alerts.Identity;
using Greenhouse.Alerts.Scheduling;
using Greenhouse.Alerts.Services;
using Microsoft.Extensions.DependencyInjection;

namespace Greenhouse.Alerts
{
    public static class Startup
    {
        public static void AddGreenhouseAlerts(this IServiceCollection services)
        {
            services.AddScoped<IWatcherService, WatcherService>();
            services.AddScoped<IZoneReadingService, ZoneReadingService>();
            services.AddScoped<IHarvestPlanner, HarvestPlanner>();
            services.AddScoped<IHarvestPlanWriter, HarvestPlanWriter>();
            services.AddScoped<IGrowerIdentity, GrowerIdentity>();
            services.AddScoped<IZoneAccess, ZoneAccess>();
            services.AddScoped<IAuditTrail, AuditTrail>();
            services.AddScoped<IWatcherEligibility, WatcherEligibility>();
            services.AddScoped<IZoneCache, ZoneCache>();
            services.AddScoped<IIrrigationSchedules, IrrigationSchedules>();
            services.AddScoped<IZoneRepository, ZoneRepository>();
            services.AddScoped<IWatcherRepository, WatcherRepository>();
            services.AddScoped<IReadingRepository, ReadingRepository>();
            services.AddScoped<IHarvestPlanRepository, HarvestPlanRepository>();
            services.AddScoped<IAirflowInputs, AirflowInputs>();
            services.AddScoped<IBrightnessInputs, BrightnessInputs>();
            services.AddScoped<ICarbonInputs, CarbonInputs>();
            services.AddScoped<IDewPointInputs, DewPointInputs>();
            services.AddScoped<IEvaporationInputs, EvaporationInputs>();
            services.AddScoped<IFeedInputs, FeedInputs>();
            services.AddScoped<IGrowthStageInputs, GrowthStageInputs>();
            services.AddScoped<IHumidityInputs, HumidityInputs>();
            services.AddScoped<IInfestationInputs, InfestationInputs>();
            services.AddScoped<IJunctionValveInputs, JunctionValveInputs>();
            services.AddScoped<IKilowattLoadInputs, KilowattLoadInputs>();
            services.AddScoped<ILeafTemperatureInputs, LeafTemperatureInputs>();
            services.AddScoped<IAirflowRepository, AirflowRepository>();
            services.AddScoped<IBrightnessRepository, BrightnessRepository>();
            services.AddScoped<ICarbonRepository, CarbonRepository>();
            services.AddScoped<IDewPointRepository, DewPointRepository>();
            services.AddScoped<IEvaporationRepository, EvaporationRepository>();
            services.AddScoped<IFeedRepository, FeedRepository>();
            services.AddScoped<IGrowthStageRepository, GrowthStageRepository>();
            services.AddScoped<IHumidityRepository, HumidityRepository>();
            services.AddScoped<IInfestationRepository, InfestationRepository>();
            services.AddScoped<IJunctionValveRepository, JunctionValveRepository>();
            services.AddScoped<IKilowattLoadRepository, KilowattLoadRepository>();
            services.AddScoped<ILeafTemperatureRepository, LeafTemperatureRepository>();
        }
    }
}
