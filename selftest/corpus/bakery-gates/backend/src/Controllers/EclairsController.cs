using System.Threading.Tasks;
using Bakery.Gates.Models;
using Bakery.Gates.Services;
using Microsoft.AspNetCore.Mvc;

namespace Bakery.Gates.Controllers
{
    [ApiController]
    [Route("eclairs/v1")]
    public class EclairsController : PastryControllerBase
    {
        private readonly IPastryService _pastries;

        public EclairsController(IPastryService pastries)
        {
            _pastries = pastries;
        }

        [HttpPost("bake")]
        public async Task<IActionResult> Bake([FromBody] PastryRequest request)
        {
            await _pastries.BakeAsync(request);
            return Ok();
        }
    }
}
