using System.Collections.Generic;
using QuarryDispatch.Api.Services;
using Microsoft.Extensions.DependencyInjection;

namespace QuarryDispatch.Api
{
    public static class Startup
    {
        public static void ConfigureServices(IServiceCollection services)
        {
            services.AddScoped<DispatchPlanner>();
            services.AddScoped<DispatchLedger>();
            services.AddScoped<IDispatchPlanRepository, DispatchPlanRepository>();
            services.AddScoped<SurveyA>();
            services.AddScoped<SurveyB>();
            services.AddScoped<SurveyC>();
            services.AddScoped<SurveyD>();
            services.AddScoped<IDispatchGate, PrimaryGate>();
            services.AddScoped<IDispatchGate, ShadowGate>();
            services.AddScoped<ISurveyChannel, Channel01>();
            services.AddScoped<ISurveyChannel, Channel02>();
            services.AddScoped<ISurveyChannel, Channel03>();
            services.AddScoped<ISurveyChannel, Channel04>();
            services.AddScoped<ISurveyChannel, Channel05>();
            services.AddScoped<ISurveyChannel, Channel06>();
            services.AddScoped<ISurveyChannel, Channel07>();
            services.AddScoped<ISurveyChannel, Channel08>();
            services.AddScoped<ISurveyChannel, Channel09>();
            services.AddScoped<ISurveyChannel, Channel10>();
            services.AddScoped<ISurveyChannel, Channel11>();
            services.AddScoped<ISurveyChannel, Channel12>();
            services.AddScoped<ISurveyChannel, Channel13>();
            services.AddScoped<ISurveyChannel, Channel14>();
            services.AddScoped<ISurveyChannel, Channel15>();
            services.AddScoped<ISurveyChannel, Channel16>();
            services.AddScoped<ISurveyChannel, Channel17>();
        }
    }
}
