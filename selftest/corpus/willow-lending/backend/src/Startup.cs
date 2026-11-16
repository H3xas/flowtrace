using WillowLending.Api.Services;
using Microsoft.Extensions.DependencyInjection;

namespace WillowLending.Api
{
    public static class Startup
    {
        public static void AddWillowLending(this IServiceCollection services)
        {
            services.AddScoped<ILoanService, LoanService>();
            services.AddScoped<SettlementBook>();
        }
    }
}
