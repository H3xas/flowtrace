using KilnYard.Api.Services;
using Microsoft.Extensions.DependencyInjection;

namespace KilnYard.Api
{
    public static class Startup
    {
        public static void AddKilnYard(this IServiceCollection services)
        {
            services.AddScoped<IFiringService, FiringService>();
        }
    }
}
