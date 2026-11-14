using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Tidewater.Ferry.Access;
using Tidewater.Ferry.Models;

namespace Tidewater.Ferry.Endpoints
{
    public static class ManifestEndpoints
    {
        public static void MapManifestEndpoints(this IEndpointRouteBuilder app)
        {
            app.MapPost("ferry/v1/manifest", async (PassengerRequest request, IPassengerAccess access) =>
            {
                if (request.PassengerId == null)
                {
                    await access.ResolveIdentityAsync(request);
                }

                await access.ReadIdentityAsync(request);
                return Results.Accepted();
            });
        }
    }
}
