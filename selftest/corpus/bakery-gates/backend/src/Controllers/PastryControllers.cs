using System.Threading.Tasks;
using Bakery.Gates.Filters;
using Bakery.Gates.Models;
using Bakery.Gates.Services;
using Microsoft.AspNetCore.Mvc;

namespace Bakery.Gates.Controllers
{
    [CrustCheck]
    public class PastryControllerBase : ControllerBase
    {
    }
}
